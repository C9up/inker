import { classNames, htmlAttrs, INKER_GLOBALS } from "./globals.js";
import { InkerRenderError } from "./InkerRenderError.js";
import { LruCache } from "./lruCache.js";
import { SafeString } from "./SafeString.js";
import type { Stacks } from "./stacks.js";

/**
 * Node-side renderer (62-2 pivot away from the embedded QuickJS VM). Walks the
 * JSON AST produced by the Rust `parseTemplateJson` and evaluates each
 * expression's verbatim `source` in Node's own V8 — with the registered helpers
 * and the render scope in lexical scope — exactly like Adonis Edge (one runtime,
 * helpers are plain functions in scope, callable anywhere including inside arrow
 * fns / loop-scoped args). No Rust↔Node bridge, no tape, no unsafe.
 *
 * The expression source is author-controlled (`.inker` files), the same trust
 * level as the rest of the app's code — Edge's model.
 */

// ---- JSON AST shape (mirrors the Rust `#[derive(Serialize)]` on ast.rs) ----

export type EachBindingJson =
	| { readonly Single: string }
	| { readonly Destructured: readonly [string, string] }
	| { readonly Indexed: { readonly item: string; readonly index: string } };

export type InkerNodeJson =
	| { readonly type: "Text"; readonly value: string }
	| {
			readonly type: "Interpolation";
			readonly source: string;
			readonly escape: boolean;
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "If";
			readonly condition: { readonly source: string };
			readonly line?: number;
			readonly column?: number;
			readonly then_nodes: readonly InkerNodeJson[];
			readonly else_nodes: readonly InkerNodeJson[] | null;
	  }
	| {
			readonly type: "Each";
			readonly iterable_source: string;
			readonly line?: number;
			readonly column?: number;
			readonly binding: EachBindingJson;
			readonly body_nodes: readonly InkerNodeJson[];
			readonly else_nodes: readonly InkerNodeJson[] | null;
	  }
	| {
			readonly type: "Let";
			readonly name: string;
			readonly source: string;
			/** When true, `name` is a destructuring pattern (`{ a, b }` /
			 * `[x, ...rest]`), `source` is the right-hand expression, and `names`
			 * carries the bound identifiers extracted + validated by the Rust
			 * parser (62-2). */
			readonly destructure?: boolean;
			readonly names?: readonly string[];
			readonly line?: number;
			readonly column?: number;
	  }
	| { readonly type: "Layout"; readonly name: string }
	| {
			readonly type: "Partial";
			/** The literal name; empty when `name_source` computes it. */
			readonly name: string;
			readonly name_source?: string;
			readonly line?: number;
			readonly column?: number;
	  }
	| { readonly type: "Slot"; readonly name: string }
	| {
			readonly type: "Component";
			/** The literal name; empty when `name_source` computes it. */
			readonly name: string;
			readonly name_source?: string;
			/** The props: any JavaScript expression, evaluated in the caller. */
			readonly props_source?: string;
			readonly body_nodes: readonly InkerNodeJson[];
			readonly named_slots: readonly {
				readonly name: string;
				/** `@slot('row', item)`: binds the slot call's first argument. */
				readonly scope?: string;
				readonly nodes: readonly InkerNodeJson[];
			}[];
			// ComponentNode carries these in Rust; the TS mirror had dropped them,
			// so the invocation site was invisible to the renderer. `$caller` needs
			// them, and a divergence between the two shapes is how silent gaps start.
			readonly line: number;
			readonly column: number;
	  }
	| {
			readonly type: "Section";
			readonly name: string;
			readonly body_nodes: readonly InkerNodeJson[];
	  }
	| { readonly type: "Super" }
	| {
			readonly type: "TrimNewline";
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "Eval";
			readonly source: string;
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "Dump";
			readonly source: string;
			/** `@dd` — print, then abort the render. */
			readonly die?: boolean;
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "Assign";
			/** Left-hand side plus the operator, e.g. `total +=`. */
			readonly target: string;
			/** The right-hand expression alone. */
			readonly source: string;
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "Inject";
			readonly source: string;
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "Debugger";
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "NewError";
			readonly source: string;
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "Stack";
			readonly source: string;
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "PushTo";
			readonly source: string;
			readonly once: boolean;
			readonly body_nodes: readonly InkerNodeJson[];
			readonly line: number;
			readonly column: number;
	  }
	| {
			readonly type: "CustomTag";
			readonly name: string;
			readonly args_source: string;
			/** Body of a `block: true` tag; empty for an inline or `@!name` tag. */
			readonly body_nodes: readonly InkerNodeJson[];
			readonly line?: number;
			readonly column?: number;
	  };

// ---- HTML escaping — the 8 characters inker escapes in `{{ }}` (Rust escape.rs) ----

const ESCAPE_RE = /[&<>"'`\u2028\u2029]/g;
const ESCAPE_MAP: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
	"`": "&#96;",
	"\u2028": "&#x2028;",
	"\u2029": "&#x2029;",
};

function escapeHtml(s: string): string {
	return s.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch] ?? ch);
}

// ---- Expression evaluation in V8 (helpers + scope in scope, Edge model) ----

export type HelperMap = ReadonlyMap<
	string,
	(...args: readonly unknown[]) => unknown
>;

// ---- Custom tags (AdonisJS/Edge `registerTag`) ----

/**
 * The token a custom tag's `compile` receives (Edge `token` parity). `jsArg` is
 * the verbatim argument source between the tag's parens (`@svg('x')` → `'x'`).
 */
export interface InkerTagToken {
	readonly properties: { readonly jsArg: string };
	readonly filename: string;
	readonly loc: {
		readonly start: { readonly line: number; readonly col: number };
	};
	/**
	 * Render this tag's body and return the HTML (block tags only; an inline
	 * tag returns `""`). INKER DEVIATION (named): Edge hands a block tag its
	 * raw `token.children` lexer tokens to re-emit through the parser. Inker
	 * has already parsed and is walking the tree, so the body arrives rendered
	 * — which is what a wrapping tag wants anyway.
	 */
	/**
	 * Render this tag's body, optionally with extra bindings in scope.
	 *
	 * `locals` is how a tag hands its body a value: Adonis's `@error` binds
	 * `$message`, `@errors` binds `$messages`, by declaring the variable on the
	 * parser stack before emitting the body. Walking an AST, the binding is
	 * folded into the body's scope frame instead — same effect, and it stays
	 * scoped to the body.
	 */
	renderBody(
		locals?: Readonly<Record<string, unknown>>,
	): string | Promise<string>;
	/**
	 * Evaluate a template expression in the scope this tag was reached in.
	 *
	 * INKER DEVIATION (named): Adonis emits `state.<x>` into the JavaScript it
	 * compiles, so its tags read the render scope for free. Walking an AST,
	 * `compile` has no such reach — this is the equivalent, and it is what an
	 * authorization tag needs to find the request's bouncer and to resolve its
	 * own arguments.
	 */
	evaluate(expression: string): unknown;
}

/**
 * The output buffer a custom tag's `compile` writes to (Edge `buffer` parity).
 * `writeRaw` emits verbatim markup; `outputExpression` evaluates a template
 * expression (a JS source string) in the render scope and emits its value.
 */
export interface InkerTagBuffer {
	writeRaw(text: string): void;
	outputExpression(
		jsExpression: string,
		filename: string,
		line: number,
		shouldEscape: boolean,
	): void;
}

/**
 * The parser a custom tag's `compile` receives (Edge `parser` parity). Minimal
 * for now — the canonical Edge tags (`@svg`, `@time`) don't touch it; reserved
 * for later `parseJsArg` / `stringifyExpression` parity.
 */
export interface InkerTagParser {
	readonly utils: Readonly<Record<string, never>>;
}

/**
 * A custom tag definition (AdonisJS/Edge `registerTag`). `@<tagName>(jsArg)` in a
 * template runs `compile(parser, buffer, token)`, which writes markup to the
 * buffer. INKER DEVIATION (named): Edge runs `compile` ONCE at template
 * compilation (it emits JS); inker parses in Rust and renders by walking the
 * JSON AST, so `compile` runs at RENDER time — same authoring model, no compile
 * phase to imitate. Only inline tags (`block: false`) are supported for now.
 */
export interface InkerTag {
	readonly tagName: string;
	readonly block: boolean;
	readonly seekable: boolean;
	/**
	 * Runs at RENDER time (see the deviation above). It may be ASYNC: an
	 * authorization tag has to await its check — Adonis's `@can` emits
	 * `await bouncer.can(...)` — and a synchronous render raises rather than
	 * emitting a pending promise.
	 */
	compile(
		parser: InkerTagParser,
		buffer: InkerTagBuffer,
		token: InkerTagToken,
	): void | Promise<void>;
}

export type TagMap = ReadonlyMap<string, InkerTag>;

const TAG_PARSER: InkerTagParser = { utils: {} };

type CompiledExpr = (scope: object, helpers: object) => unknown;

// INKER DEVIATION (named, hardening): a guard object shadowing the Node globals
// that turn "template = author-controlled code" into RCE / secret-leak. Placed
// as the OUTERMOST `with` so a legitimately-registered helper or a data key of
// the same name still wins, but a bare `process` / `require` / `globalThis` in
// an expression resolves to `undefined` instead of the real global. This is a
// bar-raise, NOT a sandbox: property-chain escapes (`({}).constructor…`) are not
// blocked — templates remain trusted code (see ADR-008). `renderString` compiles
// arbitrary source through this path, so it too must be fed trusted input only.
const SANDBOX_SHADOW: Readonly<Record<string, undefined>> = Object.freeze({
	process: undefined,
	globalThis: undefined,
	global: undefined,
	require: undefined,
	module: undefined,
	exports: undefined,
	Function: undefined,
	eval: undefined,
	__dirname: undefined,
	__filename: undefined,
});

// The names `compileExpr` binds as its own parameters. The fallback scope
// below must not claim them, or the scope objects themselves would read as
// undefined.
const SCOPE_PARAMS: ReadonlySet<string> = new Set(["$u", "$g", "$h", "$s"]);

// Outermost scope of every expression: a name found in no render scope, helper
// or shadow, and that is not a JavaScript global (`Math`, `JSON`, `Date`),
// reads as `undefined` — Edge rewrites every non-local identifier to
// `state.<name>`, so optional data is guarded with a plain `@if(name)`. An
// assignment to such a name lands on this frozen target and is dropped,
// instead of creating a global variable as sloppy-mode code otherwise would.
const MISSING_AS_UNDEFINED: object = new Proxy(Object.freeze({}), {
	has: (_target, key) =>
		typeof key === "string" && !SCOPE_PARAMS.has(key) && !(key in globalThis),
	get: () => undefined,
	set: () => true,
});

/**
 * How many compiled expressions (and, separately, `@let` destructurings) stay
 * cached. Bounded: `renderString` compiles whatever source it is given, so an
 * unbounded cache keeps one closure per distinct expression for the life of
 * the process. File templates use far fewer than this.
 */
export const COMPILED_EXPRESSION_CAPACITY = 4096;

// Compile-once cache: expression source → a JS fn evaluating it with helpers +
// scope in scope (`with` — a `new Function` body is non-strict).
const exprCache = new LruCache<string, CompiledExpr>(
	COMPILED_EXPRESSION_CAPACITY,
);

/** Number of compiled expressions currently cached. */
export function compiledExpressionCount(): number {
	return exprCache.size;
}

/** Drop every compiled expression (`Templates#clearCache`). */
export function clearCompiledExpressions(): void {
	exprCache.clear();
	destructureCache.clear();
}

/** `await` as a keyword, not as part of an identifier (`awaited`, `myAwait`). */
const AWAIT_RE = /(^|[^\w$.])await[\s(]/;

/**
 * The expression's code with the text of its string and template literals
 * blanked out (a template's `${…}` substitutions are code and stay), so a
 * literal that merely contains the word `await` does not make the
 * expression async.
 */
function codeOutsideLiterals(source: string): string {
	let out = "";
	// Each entry is the `{` depth at which a template literal's `${` opened.
	const templates: number[] = [];
	let depth = 0;
	let quote: "'" | '"' | "`" | undefined;
	for (let i = 0; i < source.length; i++) {
		const ch = source.charAt(i);
		if (quote !== undefined) {
			if (ch === "\\") {
				i++;
				out += "  ";
				continue;
			}
			if (quote === "`" && ch === "$" && source.charAt(i + 1) === "{") {
				templates.push(depth);
				depth++;
				quote = undefined;
				i++;
				out += "${";
				continue;
			}
			if (ch === quote) {
				quote = undefined;
				out += ch;
			} else {
				out += " ";
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (templates.length > 0 && templates[templates.length - 1] === depth) {
				templates.pop();
				quote = "`";
			}
		}
		out += ch;
	}
	return out;
}

const AsyncFunction: FunctionConstructor = Object.getPrototypeOf(
	async () => {},
).constructor;

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof Reflect.get(value, "then") === "function"
	);
}

function compileExpr(source: string): CompiledExpr {
	const cached = exprCache.get(source);
	if (cached !== undefined) return cached;
	let fn: CompiledExpr;
	try {
		// `new Function` — the template expression compiled to a V8 closure. This
		// is arbitrary code execution BY DESIGN, at the same trust level as the
		// application's own TypeScript: a template is a source file the author
		// wrote, not input.
		//
		// The consequence, stated plainly: rendering a template whose TEXT came
		// from a user is remote code execution. Nothing here sandboxes it, and
		// nothing is meant to — see the README. User-supplied DATA is a
		// different matter and is safe: values are HTML-escaped unless the
		// template opts out.
		// `$g` (the global shadow) is outermost, then helpers `$h`, then scope `$s`.
		// An expression using `await` has to be compiled as an ASYNC function —
		// `await` is a syntax error anywhere else — and then returns a promise
		// the walker suspends on. `with` is legal in both (a `new Function` body
		// is non-strict), so the scope chain is identical either way.
		const Ctor =
			AWAIT_RE.test(source) && AWAIT_RE.test(codeOutsideLiterals(source))
				? AsyncFunction
				: Function;
		const compiled = new Ctor(
			"$u",
			"$g",
			"$h",
			"$s",
			`with($u){ with($g){ with($h){ with($s){ return (${source}); } } } }`,
		);
		fn = (s, h) => compiled(MISSING_AS_UNDEFINED, SANDBOX_SHADOW, h, s);
	} catch (cause) {
		throw new InkerRenderError(
			"E_INKER_INVALID_EXPRESSION",
			`invalid expression \`${source}\`: ${errMessage(cause)}`,
			undefined,
			{ cause },
		);
	}
	exprCache.set(source, fn);
	return fn;
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** V8's "Maximum call stack size exceeded". */
function isStackOverflow(e: unknown): boolean {
	return e instanceof RangeError && /call stack/i.test(e.message);
}

function depthError(cause: unknown): InkerRenderError {
	return new InkerRenderError(
		"E_INKER_RENDER_DEPTH",
		`the render nested too deep: ${errMessage(cause)}`,
		undefined,
		{ cause },
	);
}

function evalExpr(
	source: string,
	scope: object,
	helpers: object,
	pos?: { readonly line?: number; readonly column?: number },
): unknown {
	try {
		return compileExpr(source)(scope, helpers);
	} catch (cause) {
		if (cause instanceof InkerRenderError) throw cause;
		if (isStackOverflow(cause)) throw depthError(cause);
		const msg = errMessage(cause);
		const callee = unknownCallee(msg, scope, helpers);
		if (callee !== undefined) {
			throw new InkerRenderError(
				"E_INKER_UNKNOWN_IDENTIFIER",
				`'${callee}' is not a helper, a global or a function in the render data${suggestHelper(callee, helpers)}`,
				{ line: pos?.line, column: pos?.column, expression: source },
				{ cause },
			);
		}
		// Navigating into null/undefined maps to the same typed code the retired
		// Rust path resolver produced.
		const code = /is not defined|cannot read propert/i.test(msg)
			? "E_INKER_UNKNOWN_IDENTIFIER"
			: "E_INKER_INVALID_EXPRESSION";
		throw new InkerRenderError(
			code,
			msg,
			{ line: pos?.line, column: pos?.column },
			{ cause },
		);
	}
}

/**
 * The bare name a failed call was made through, when nothing in scope carries
 * it — the typo case the parser used to reject before callees were resolved
 * at render time.
 */
function unknownCallee(
	message: string,
	scope: object,
	helpers: object,
): string | undefined {
	const match = /^([A-Za-z_$][\w$]*) is not a function$/.exec(message);
	const name = match?.[1];
	if (name === undefined || name in scope || name in helpers) return undefined;
	return name;
}

/** "did you mean …" for the closest helper name, when one is close enough. */
function suggestHelper(name: string, helpers: object): string {
	let best: string | undefined;
	let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1;
	for (const candidate of Object.keys(helpers)) {
		const distance = editDistance(name, candidate);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best === undefined ? "" : ` — did you mean '${best}'?`;
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + cost,
			);
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

/**
 * What a walker step yields: a value it is waiting on. Only a thenable is ever
 * yielded, so a template with no `await` never suspends and the walk stays a
 * plain call chain.
 */
type RenderStep = Generator<PromiseLike<unknown>, void, unknown>;

/** Evaluate an expression, suspending the walk if it produced a promise. */
function* evalStep(
	source: string,
	scope: object,
	helpers: object,
	pos?: { readonly line?: number; readonly column?: number },
): Generator<PromiseLike<unknown>, unknown, unknown> {
	const value = evalExpr(source, scope, helpers, pos);
	return isThenable(value) ? yield value : value;
}

/**
 * Run a walk to completion.
 *
 * Returns the rendered string when the template never suspended, and a promise
 * when it did — which is what lets one walker serve both `renderString` (sync)
 * and `render` (async) without a second copy to keep in step. Adonis reaches
 * the same place with two compilers; parsing in Rust and walking the AST, this
 * is the shape that fits.
 */
/**
 * Run a walk that must finish synchronously — a custom tag's `compile` and the
 * sync render entry points are plain callbacks with nowhere to await. Suspending
 * there is an authoring error, reported as one rather than leaking a promise
 * into the output.
 */
function driveSync(step: RenderStep, out: string[], what: string): string {
	const next = guardDepth(() => step.next());
	while (!next.done) {
		step.return(undefined);
		throw new InkerRenderError(
			"E_INKER_ASYNC_NOT_SUPPORTED",
			`${what} cannot use \`await\` — it renders synchronously`,
		);
	}
	return out.join("");
}

function drive(step: RenderStep, out: string[]): string | Promise<string> {
	let next = guardDepth(() => step.next());
	while (!next.done) {
		const pending = next.value;
		if (!isThenable(pending)) {
			next = guardDepth(() => step.next(pending));
			continue;
		}
		return (async () => {
			const resumed = await pending;
			let cur = guardDepth(() => step.next(resumed));
			while (!cur.done) {
				const value = await cur.value;
				cur = guardDepth(() => step.next(value));
			}
			return out.join("");
		})();
	}
	return out.join("");
}

/**
 * Backstop for a walk that overflowed the V8 stack: the parser caps block
 * nesting and the walker caps component depth, but a helper can still recurse
 * without end, and an untyped RangeError must not reach the caller.
 */
function guardDepth<T>(fn: () => T): T {
	try {
		return fn();
	} catch (cause) {
		throw isStackOverflow(cause) ? depthError(cause) : cause;
	}
}

// ---- @let destructuring (62-2 Edge parity): `@let({ a, b } = obj)` ----
//
// Like Edge (which compiles the pattern with a real JS parser), the Rust parser
// captures the verbatim pattern (as `name`) + the right-hand `source`, AND
// extracts + validates the bound identifiers (`names`) at parse time — invalid /
// reserved / prototype-pollution binding names error there, with a JS-aware
// scanner so a `,`/`=` inside a default value never mis-splits the pattern. Here
// we only compile `const <pattern> = (<rhs>); return { <names> }` in V8 and
// thread the bound values into the render scope; `names` is already trusted.

const destructureCache = new LruCache<
	string,
	(scope: object, helpers: object) => Record<string, unknown>
>(COMPILED_EXPRESSION_CAPACITY);

/** Evaluate a destructuring `@let` and return the newly-bound names as an
 * object to fold into the render scope. `names` are the Rust-validated bound
 * identifiers. */
function evalLetDestructure(
	pattern: string,
	rhs: string,
	names: readonly string[],
	scope: object,
	helpers: object,
	pos: { readonly line?: number; readonly column?: number },
): Record<string, unknown> {
	const key = `${pattern} ${rhs}`;
	let fn = destructureCache.get(key);
	if (fn === undefined) {
		try {
			// Same trust boundary as `compileExpr` above: the pattern and the
			// right-hand side are template source, which is code the author
			// wrote. Never build one of these from anything a request carried.
			const compiled = new Function(
				"$u",
				"$g",
				"$h",
				"$s",
				`with($u){ with($g){ with($h){ with($s){ const ${pattern} = (${rhs}); return { ${names.join(", ")} }; } } } }`,
			);
			// `compiled` (a `Function`) returns `any`, assignable to the declared
			// `Record<string, unknown>` result without a cast.
			fn = (s, h) => compiled(MISSING_AS_UNDEFINED, SANDBOX_SHADOW, h, s);
		} catch (cause) {
			throw new InkerRenderError(
				"E_INKER_INVALID_EXPRESSION",
				`invalid @let destructuring \`${pattern} = ${rhs}\`: ${errMessage(cause)}`,
				{ line: pos.line, column: pos.column },
				{ cause },
			);
		}
		destructureCache.set(key, fn);
	}
	try {
		return fn(scope, helpers);
	} catch (cause) {
		if (cause instanceof InkerRenderError) throw cause;
		const msg = errMessage(cause);
		const code = /is not defined|cannot read propert|cannot destructure/i.test(
			msg,
		)
			? "E_INKER_UNKNOWN_IDENTIFIER"
			: "E_INKER_INVALID_EXPRESSION";
		throw new InkerRenderError(
			code,
			msg,
			{ line: pos.line, column: pos.column },
			{ cause },
		);
	}
}

/**
 * The string form of an interpolated value (Edge `escape`: `String(input)`).
 * A Date, an array or a class with `toString()` prints the way JavaScript
 * prints it; `{{ }}` still escapes the result, so a `toString()` returning
 * markup cannot inject it.
 */
function stringifyScalar(v: unknown, source: string): string {
	switch (typeof v) {
		case "string":
			return v;
		case "boolean":
			return v ? "true" : "false";
		default:
			try {
				return String(v);
			} catch (cause) {
				throw new InkerRenderError(
					"E_INKER_INVALID_EXPRESSION",
					`cannot interpolate the value of \`${source}\`: ${errMessage(cause)}`,
					undefined,
					{ cause },
				);
			}
	}
}

export interface NodeRenderContext {
	/** Layout body-injection target for `{{> body }}`. */
	readonly bodyHtml?: string;
	/**
	 * Component slot content by name; `{{> name }}` resolves from here. Slots
	 * are THUNKS, not strings: Edge renders a slot when it is used, which is
	 * what makes `@inject` work — a component injects into `$context` first,
	 * then its slot body renders and nested components see the injected values.
	 * Pre-rendering the bodies would run them before `@inject` ever executed.
	 */
	readonly slots?: ReadonlyMap<
		string,
		(...args: readonly unknown[]) => string | Promise<string>
	>;
	/**
	 * Shared state provided by an enclosing component (`@inject`), read by
	 * nested components as `$context`. Undefined at the top level, which is how
	 * `@inject` detects being used outside a component.
	 */
	readonly context?: Record<string, unknown>;
	/** Named output stacks for `@stack` / `@pushTo` / `@pushOnceTo`. */
	readonly stacks?: Stacks;
	/** Pre-loaded `@include` partials by normalized key → their node list. */
	readonly partials?: ReadonlyMap<string, readonly InkerNodeJson[]>;
	/** Pre-loaded `@component` templates by normalized key → their node list. */
	readonly components?: ReadonlyMap<string, readonly InkerNodeJson[]>;
	/**
	 * Partials / components the preload found no file for. Not an error until
	 * one actually renders — Edge resolves them at that point, so one behind an
	 * untaken `@if` / `@includeIf` costs nothing.
	 */
	readonly missingPartials?: ReadonlyMap<string, InkerRenderError>;
	readonly missingComponents?: ReadonlyMap<string, InkerRenderError>;
	/** How many partials / components deep this walk is. */
	readonly depth?: number;
	/**
	 * Load a partial or component the preload did not cover — one whose name
	 * is only known at render time (`@include(which)`), or one a template
	 * loaded that way references in turn. Validates the name and its
	 * containment exactly as the preload does. Absent for `renderString`,
	 * which has no disk.
	 */
	readonly loadTemplate?: (
		kind: "partial" | "component",
		name: string,
	) => readonly InkerNodeJson[] | Promise<readonly InkerNodeJson[]>;
	/** Rendered `@section` content by name (child fills, injected at layout yields). */
	readonly sections?: ReadonlyMap<string, string>;
	/** Layout's default content for the section currently being rendered (`@super`). */
	readonly superHtml?: string;
	/** Name of the template being rendered — surfaced to components as `$caller.filename`. */
	readonly templateName?: string;
	/**
	 * Identity of the template FILE whose nodes are being walked: the entry,
	 * a partial, a component or the layout. `@pushOnceTo` keys on it, as Edge
	 * keys on the tag's own filename, so two files never share a call site.
	 */
	readonly file?: string;
	/** Runtime-registered custom tags; a `@<name>(...)` resolves its handler here. */
	readonly tags?: TagMap;
	/**
	 * Engine globals plus the renderer's `share()`d values (Edge
	 * `#sharedState`). Every component scope starts from it, under its props;
	 * the caller's per-call data never reaches a component.
	 */
	readonly sharedState?: Readonly<Record<string, unknown>>;
}

/** Split a node list into its top-level `@section` blocks and the rest (the
 * default body). Used to separate a child's sections from its `{{> body }}`
 * content, and to collect a layout's section yields + their defaults. */
export function collectSections(nodes: readonly InkerNodeJson[]): {
	sections: Map<string, readonly InkerNodeJson[]>;
	body: InkerNodeJson[];
} {
	const sections = new Map<string, readonly InkerNodeJson[]>();
	const body: InkerNodeJson[] = [];
	for (const node of nodes) {
		if (node.type === "Section") {
			sections.set(node.name, node.body_nodes);
		} else {
			body.push(node);
		}
	}
	return { sections, body };
}

/**
 * How many partials / components may nest in one render. Recursion is legal
 * (a tree component renders itself per child) and ends on the data; this
 * bound turns a recursion that never ends into a typed error instead of a
 * stack overflow.
 */
const MAX_TEMPLATE_DEPTH = 100;

function nextDepth(ctx: NodeRenderContext, what: string): number {
	const depth = (ctx.depth ?? 0) + 1;
	if (depth > MAX_TEMPLATE_DEPTH) {
		throw new InkerRenderError(
			"E_INKER_RENDER_DEPTH",
			`${what} nests partials/components more than ${MAX_TEMPLATE_DEPTH} levels deep — a recursion that never ends on the data`,
			{ templateName: ctx.templateName },
		);
	}
	return depth;
}

/** The file a component key resolves to, in the namespace of template names. */
function componentFile(key: string): string {
	const sep = key.indexOf("::");
	return sep === -1
		? `components/${key}`
		: `${key.slice(0, sep)}::components/${key.slice(sep + 2)}`;
}

/** Mirror the Rust `normalize_partial_key`: strip `./`, collapse `//`, drop
 * `/./` and a trailing `/`. */
export function normalizePartialKey(name: string): string {
	let k = name.replace(/\/\.\//g, "/").replace(/\/{2,}/g, "/");
	if (k.startsWith("./")) k = k.slice(2);
	if (k.endsWith("/")) k = k.slice(0, -1);
	return k;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Derive a nested scope frame from `parent`. Frames CHAIN through the prototype
 * rather than flattening with a spread, which is what lets `@assign` reach the
 * frame that actually owns a binding: `@let(total = 0)` outside a loop and
 * `@assign(total = total + 1)` inside it must hit the same slot, and a spread
 * copy would strand the write on a per-iteration duplicate. `with()` reads walk
 * the chain, so lookup is unchanged.
 *
 * `defineProperty` rather than assignment: a `__proto__` key would otherwise
 * invoke the setter and re-point the chain instead of adding a binding. Binding
 * names are validated in Rust, so this is depth, not the only guard.
 */
function childScope(parent: object, bindings: Record<string, unknown>): object {
	const frame: Record<string, unknown> = Object.create(parent);
	for (const key of Object.keys(bindings)) {
		Object.defineProperty(frame, key, {
			value: bindings[key],
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return frame;
}

/** A plain identifier target for `@assign`, as opposed to a member path. */
const BARE_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Keys `@inject` refuses to copy into `$context`. */
const PROTO_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

/**
 * The stack store for this render. It is created by the composer (one per
 * `render()`, shared by body, sections and layout) — a missing one means a
 * stack tag was reached through a code path that never set one up, which is a
 * wiring bug, not an authoring mistake.
 */
function requireStacks(
	ctx: NodeRenderContext,
	tag: string,
	pos: { readonly line?: number; readonly column?: number },
): Stacks {
	if (ctx.stacks === undefined) {
		throw new InkerRenderError(
			"E_INKER_INVALID_EXPRESSION",
			`${tag} used in a render with no stack store`,
			{ line: pos.line, column: pos.column },
		);
	}
	return ctx.stacks;
}

/**
 * Drop one line break from the end of what has been output so far — the one
 * leading into the next line (Edge's `~` marker on a tag line).
 */
function trimTrailingNewline(out: string[]): void {
	for (let i = out.length - 1; i >= 0; i--) {
		const chunk = out[i] ?? "";
		if (chunk === "") continue;
		if (chunk.endsWith("\r\n")) out[i] = chunk.slice(0, -2);
		else if (chunk.endsWith("\n")) out[i] = chunk.slice(0, -1);
		return;
	}
}

/** Find the frame in the scope chain that OWNS `name`, or null if none does. */
function ownerFrame(scope: object, name: string): object | null {
	let frame: object | null = scope;
	while (frame !== null) {
		if (Object.hasOwn(frame, name)) return frame;
		const parent: object | null = Object.getPrototypeOf(frame);
		frame = parent;
	}
	return null;
}

/** The outermost frame of a scope chain: the render's (or component's) own state. */
function rootFrame(scope: object): object {
	let frame = scope;
	for (;;) {
		const parent: object | null = Object.getPrototypeOf(frame);
		if (parent === null || parent === Object.prototype) return frame;
		frame = parent;
	}
}

// ---- The walker ----

/** Render a list of sibling nodes, threading `@let` bindings forward. */
function* renderNodes(
	nodes: readonly InkerNodeJson[],
	data: object,
	helpers: Record<string, unknown>,
	ctx: NodeRenderContext,
	out: string[],
): RenderStep {
	let scope = data;
	for (const node of nodes) {
		if (node.type === "Let") {
			// `@let` short-circuits `renderNode`, so its own line has to be
			// stamped here or the binding would evaluate under the previous
			// node's `$lineNumber`.
			if (node.line !== undefined) helpers.$lineNumber = node.line;
			if (node.destructure) {
				scope = childScope(
					scope,
					evalLetDestructure(
						node.name,
						node.source,
						node.names ?? [],
						scope,
						helpers,
						node,
					),
				);
			} else {
				const value = yield* evalStep(node.source, scope, helpers, node);
				scope = childScope(scope, { [node.name]: value });
			}
			continue;
		}
		yield* renderNode(node, scope, helpers, ctx, out);
	}
}

function* renderNode(
	node: InkerNodeJson,
	scope: object,
	helpers: Record<string, unknown>,
	ctx: NodeRenderContext,
	out: string[],
): RenderStep {
	// Edge emits line tracking into the compiled template, which is what makes
	// `$lineNumber` readable from a template. Walking instead, the walker is the
	// only place that knows — one write per node, in the layer under the render
	// data so a caller's own `$lineNumber` key still wins.
	if ("line" in node) helpers.$lineNumber = node.line;
	switch (node.type) {
		case "Text":
			out.push(node.value);
			return;
		case "Interpolation": {
			const v = yield* evalStep(node.source, scope, helpers, node);
			if (v instanceof SafeString) {
				out.push(v.value);
			} else if (v === null || v === undefined) {
				// renders empty
			} else if (node.escape) {
				out.push(escapeHtml(stringifyScalar(v, node.source)));
			} else {
				out.push(stringifyScalar(v, node.source));
			}
			return;
		}
		case "If": {
			const v = yield* evalStep(node.condition.source, scope, helpers, node);
			if (v) {
				yield* renderNodes(node.then_nodes, scope, helpers, ctx, out);
			} else if (node.else_nodes) {
				yield* renderNodes(node.else_nodes, scope, helpers, ctx, out);
			}
			return;
		}
		case "Each":
			yield* renderEach(node, scope, helpers, ctx, out);
			return;
		case "Slot": {
			const slot = ctx.slots?.get(node.name);
			if (slot !== undefined) {
				const html = slot();
				out.push(isThenable(html) ? String(yield html) : html);
			} else if (node.name === "body" && ctx.bodyHtml !== undefined) {
				out.push(ctx.bodyHtml);
			}
			// unknown slot → empty (Edge parity)
			return;
		}
		case "Partial": {
			// `@include('name')` renders the partial's nodes in the SAME scope.
			const raw = yield* templateName(node, scope, helpers, "@include");
			const name = normalizePartialKey(raw);
			const partial = yield* templateNodes(ctx, "partial", raw, name);
			// Same scope as the host, but the partial is its own file: `$filename`,
			// `@newError` and `@pushOnceTo` must name it, not the host.
			yield* renderNodes(
				partial,
				childScope(scope, { $filename: name }),
				helpers,
				{
					...ctx,
					templateName: name,
					file: name,
					depth: nextDepth(ctx, `@include('${raw}')`),
				},
				out,
			);
			return;
		}
		case "Component":
			yield* renderComponent(node, scope, helpers, ctx, out);
			return;
		case "Section": {
			// In a layout, a `@section('name')` is a yield: inject the child's
			// filled content if present, else render the layout's default body.
			// In a standalone template (no layout), it just renders inline.
			const filled = ctx.sections?.get(node.name);
			if (filled !== undefined) {
				out.push(filled);
			} else {
				yield* renderNodes(node.body_nodes, scope, helpers, ctx, out);
			}
			return;
		}
		case "Super":
			// Inside a child section: the layout's default content for it.
			if (ctx.superHtml !== undefined) out.push(ctx.superHtml);
			return;
		case "TrimNewline":
			trimTrailingNewline(out);
			return;
		case "Eval":
			// Evaluate for side effects (e.g. a helper call); emit nothing.
			yield* evalStep(node.source, scope, helpers, node);
			return;
		case "Dump": {
			// Pretty-print the value for debugging (Edge `@dump`).
			const value = yield* evalStep(node.source, scope, helpers, node);
			let json: string;
			try {
				json = JSON.stringify(value, null, 2) ?? String(value);
			} catch {
				json = String(value);
			}
			out.push(`<pre class="inker-dump">${escapeHtml(json)}</pre>`);
			// `@dd` — dump and die. The dump is already in `out`, but the render
			// is abandoned, so it is carried on the error for the caller to show.
			if (node.die) {
				throw new InkerRenderError(
					"E_INKER_DUMP_DIE",
					`@dd(${node.source}) stopped the render:\n${json}`,
					{ line: node.line, column: node.column, expression: node.source },
				);
			}
			return;
		}
		case "Assign": {
			// `target` is `<lhs> <operator>`; splitting them in Rust is what lets a
			// bare identifier be written back to the frame that owns it.
			const opStart = node.target.lastIndexOf(" ");
			const lhs = node.target.slice(0, opStart);
			const operator = node.target.slice(opStart + 1);
			if (BARE_IDENT_RE.test(lhs)) {
				// Compute in the reading scope, then store in the OWNING frame —
				// `with(){ x = … }` would create a shadowing copy on the innermost
				// frame instead, so a loop's writes would vanish at each iteration.
				// A name no frame owns is created on the render's top frame, as
				// Edge's `state.<name> = …` does.
				const owner = ownerFrame(scope, lhs) ?? rootFrame(scope);
				const rhs =
					operator === "="
						? node.source
						: `(${lhs}) ${operator.slice(0, -1)} (${node.source})`;
				const value = yield* evalStep(rhs, scope, helpers, node);
				Object.defineProperty(owner, lhs, {
					value,
					writable: true,
					enumerable: true,
					configurable: true,
				});
			} else {
				// A member path (`user.name`, `rows[0].qty`) mutates the object it
				// points at, so evaluating the assignment is the assignment.
				yield* evalStep(
					`${lhs} ${operator} (${node.source})`,
					scope,
					helpers,
					node,
				);
			}
			return;
		}
		case "Inject": {
			if (ctx.context === undefined) {
				throw new InkerRenderError(
					"E_INKER_INVALID_EXPRESSION",
					"@inject can only be used inside a component — there is no $context to write to at the top level",
					{ line: node.line, column: node.column },
				);
			}
			const value = yield* evalStep(node.source, scope, helpers, node);
			if (!isRecord(value)) {
				throw new InkerRenderError(
					"E_INKER_INVALID_EXPRESSION",
					`@inject(${node.source}) expects an object, got ${value === null ? "null" : typeof value}`,
					{ line: node.line, column: node.column },
				);
			}
			for (const key of Object.keys(value)) {
				if (PROTO_KEYS.has(key)) continue;
				ctx.context[key] = value[key];
			}
			return;
		}
		case "Debugger":
			// Edge compiles `@debugger` to a `debugger` statement; with the AST
			// walked rather than compiled, the breakpoint lands here — still under
			// `node --inspect`, and `node` / `scope` / `ctx` are the template's own
			// state at that point, which is what the author wants to inspect.
			// biome-ignore lint/suspicious/noDebugger: the statement IS the feature — `@debugger` has no other implementation.
			debugger;
			return;
		case "NewError": {
			// `@newError(message, filename?, line?, col?)` — the position args let a
			// component blame its CALLER (`$caller.line`) rather than itself.
			const parts = yield* evalStep(`[${node.source}]`, scope, helpers, node);
			const [message, filename, line, column] = Array.isArray(parts)
				? parts
				: [parts];
			throw new InkerRenderError(
				"E_INKER_TEMPLATE_ERROR",
				typeof message === "string" ? message : String(message),
				{
					line: typeof line === "number" ? line : node.line,
					column: typeof column === "number" ? column : node.column,
					templateName:
						typeof filename === "string" ? filename : ctx.templateName,
				},
			);
		}
		case "Stack": {
			const name = yield* evalStep(node.source, scope, helpers, node);
			if (typeof name !== "string") {
				throw new InkerRenderError(
					"E_INKER_INVALID_EXPRESSION",
					`@stack(${node.source}) expects a string name, got ${typeof name}`,
					{ line: node.line, column: node.column },
				);
			}
			out.push(requireStacks(ctx, "@stack", node).create(name));
			return;
		}
		case "PushTo": {
			const name = yield* evalStep(node.source, scope, helpers, node);
			if (typeof name !== "string") {
				throw new InkerRenderError(
					"E_INKER_INVALID_EXPRESSION",
					`@${node.once ? "pushOnceTo" : "pushTo"}(${node.source}) expects a string name, got ${typeof name}`,
					{ line: node.line, column: node.column },
				);
			}
			const stacks = requireStacks(
				ctx,
				`@${node.once ? "pushOnceTo" : "pushTo"}`,
				node,
			);
			if (node.once) {
				// The source id is the CALL SITE, so a component used ten times
				// contributes its script tag once — which is the tag's whole point.
				// Rendering the body is skipped entirely on a repeat.
				const sourceId = `${ctx.file ?? ctx.templateName ?? "?"}:${node.line}:${node.column}`;
				if (stacks.hasSource(name, sourceId)) return;
				const body: string[] = [];
				yield* renderNodes(node.body_nodes, scope, helpers, ctx, body);
				stacks.pushOnceTo(name, sourceId, body.join(""));
			} else {
				const body: string[] = [];
				yield* renderNodes(node.body_nodes, scope, helpers, ctx, body);
				stacks.pushTo(name, body.join(""));
			}
			return;
		}
		case "CustomTag": {
			// `@<tagName>(jsArg)` — a registered custom tag (Edge `registerTag`).
			const tag = ctx.tags?.get(node.name);
			if (tag === undefined) {
				throw new InkerRenderError(
					"E_INKER_UNKNOWN_TAG",
					`@${node.name} — no tag registered with this name (register it with \`templates.registerTag({ tagName: '${node.name}', … })\`)`,
					{ line: node.line, column: node.column },
				);
			}
			const jsArg = node.args_source;
			if (!tag.seekable && jsArg.trim() !== "") {
				throw new InkerRenderError(
					"E_INKER_INVALID_EXPRESSION",
					`@${node.name} does not accept arguments (registered with seekable: false)`,
					{ line: node.line, column: node.column },
				);
			}
			const token: InkerTagToken = {
				properties: { jsArg },
				filename: ctx.templateName ?? "",
				loc: { start: { line: node.line ?? 0, col: node.column ?? 0 } },
				// Rendered on demand, in the tag's own scope. A block tag that
				// discards its body (a `@cache` miss, a permission check) never
				// pays for it, and one that wraps its body calls this once.
				// Like a slot: a string when the body finished synchronously, a
				// promise when it suspended — so a tag that awaits its own check
				// can `await token.renderBody()`.
				renderBody: (locals) => {
					const bodyOut: string[] = [];
					const bodyScope =
						locals === undefined ? scope : childScope(scope, { ...locals });
					return drive(
						renderNodes(node.body_nodes, bodyScope, helpers, ctx, bodyOut),
						bodyOut,
					);
				},
				evaluate: (expression) =>
					evalExpr(expression, scope, helpers, {
						line: node.line,
						column: node.column,
					}),
			};
			const buffer: InkerTagBuffer = {
				writeRaw: (text) => {
					out.push(text);
				},
				outputExpression: (expr, _filename, line, shouldEscape) => {
					const v = evalExpr(expr, scope, helpers, {
						line,
						column: node.column,
					});
					if (isThenable(v)) {
						throw new InkerRenderError(
							"E_INKER_ASYNC_NOT_SUPPORTED",
							`@${node.name} cannot output an awaited expression — a tag renders synchronously`,
							{ line, column: node.column },
						);
					}
					if (v instanceof SafeString) {
						out.push(v.value);
					} else if (v === null || v === undefined) {
						// renders empty
					} else if (shouldEscape) {
						out.push(escapeHtml(stringifyScalar(v, expr)));
					} else {
						out.push(stringifyScalar(v, expr));
					}
				},
			};
			const compiled = tag.compile(TAG_PARSER, buffer, token);
			// An async tag suspends the walk here, so everything it wrote lands
			// in order and nothing else renders in between.
			if (isThenable(compiled)) yield compiled;
			return;
		}
		case "Layout":
			// The composer strips `@layout()` before render; a residual one is a
			// no-op (its body/slot injection is handled outside the walker).
			return;
		default:
			throw new InkerRenderError(
				"E_INKER_INVALID_EXPRESSION",
				`node type '${node.type}' is not yet handled by the Node renderer`,
			);
	}
}

function* renderEach(
	node: Extract<InkerNodeJson, { type: "Each" }>,
	scope: object,
	helpers: Record<string, unknown>,
	ctx: NodeRenderContext,
	out: string[],
): RenderStep {
	const iterable = yield* evalStep(node.iterable_source, scope, helpers, node);

	// A `[k, v]` destructured binding means "each element is a pair" ONLY when
	// iterating an array of pairs; over an object/Map/Set it binds key + value.
	// Decide by the ITERABLE kind, never by the element shape (an object whose
	// value happens to be an array must not be mistaken for a pair).
	const arrayOfPairs = Array.isArray(iterable);

	// [value, key/index] pairs in iteration order.
	const entries: Array<readonly [unknown, unknown]> = [];
	if (Array.isArray(iterable)) {
		for (let i = 0; i < iterable.length; i++) entries.push([iterable[i], i]);
	} else if (iterable instanceof Map) {
		for (const [k, val] of iterable) entries.push([val, k]);
	} else if (iterable instanceof Set) {
		let i = 0;
		for (const val of iterable) entries.push([val, i++]);
	} else if (typeof iterable === "string") {
		// Per code point, as `for…of` reads a string (Edge `each`).
		let i = 0;
		for (const ch of iterable) entries.push([ch, i++]);
	} else if (isRecord(iterable)) {
		// Every own entry, `constructor` and `__proto__` included: they are
		// ordinary data keys here, and bindings are defined on a fresh frame
		// (`childScope`), never assigned through a prototype.
		for (const [k, val] of Object.entries(iterable)) entries.push([val, k]);
	} else {
		// A null/undefined iterable is the common "maybe-absent value" mistake —
		// point at the `@if()` guard (parity with the Rust hint).
		const hint =
			iterable === null || iterable === undefined
				? " — wrap the loop in `@if()` to guard a possibly-absent value"
				: "";
		throw new InkerRenderError(
			"E_INKER_INVALID_ITERABLE",
			`@each iterable \`${node.iterable_source}\` is not an array, a string or an object${hint}`,
		);
	}

	if (entries.length === 0) {
		if (node.else_nodes)
			yield* renderNodes(node.else_nodes, scope, helpers, ctx, out);
		return;
	}

	const binding = node.binding;
	for (const [value, key] of entries) {
		let bindings: Record<string, unknown>;
		if ("Single" in binding) {
			bindings = { [binding.Single]: value };
		} else if ("Destructured" in binding) {
			const [kName, vName] = binding.Destructured;
			// array-of-pairs: `value` is `[k, v]`; object/Map/Set: key + value.
			bindings =
				arrayOfPairs && Array.isArray(value)
					? { [kName]: value[0], [vName]: value[1] }
					: { [kName]: key, [vName]: value };
		} else {
			bindings = {
				[binding.Indexed.item]: value,
				[binding.Indexed.index]: key,
			};
		}
		yield* renderNodes(
			node.body_nodes,
			childScope(scope, bindings),
			helpers,
			ctx,
			out,
		);
	}
}

// ---- Edge $props API (62-4): chainable prop manipulation inside a component ----

interface PropsApi {
	all(): Record<string, unknown>;
	get(key: string, fallback?: unknown): unknown;
	has(key: string): boolean;
	only(keys: readonly string[]): PropsApi;
	except(keys: readonly string[]): PropsApi;
	merge(defaults: Record<string, unknown>): PropsApi;
	mergeIf(condition: unknown, defaults: Record<string, unknown>): PropsApi;
	mergeUnless(condition: unknown, defaults: Record<string, unknown>): PropsApi;
	toAttrs(): SafeString;
}

/** Every class in a `class` value, whatever form it takes (string, array, object). */
function classList(value: unknown): string[] {
	const joined = classNames(value);
	return joined === "" ? [] : joined.split(" ");
}

/**
 * Defaults under the caller's props (caller wins), with `class` unioned —
 * defaults first — across its string, array and object forms (Edge `merge`).
 */
function mergeProps(
	values: Record<string, unknown>,
	defaults: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...defaults, ...values };
	if (
		Object.hasOwn(defaults, "class") &&
		Object.hasOwn(values, "class") &&
		defaults.class &&
		values.class
	) {
		out.class = [
			...new Set([...classList(defaults.class), ...classList(values.class)]),
		].join(" ");
	}
	return out;
}

/** Path segments of `a.b[0].c`, as lodash `get` / `has` read them. */
function propPath(key: string): string[] {
	return key.match(/[^.[\]]+/g) ?? [];
}

/**
 * Walk a dot path over OWN properties only. A `__proto__` / `constructor` /
 * `prototype` segment ends the walk, so `$props.get('x.constructor')` can
 * never hand a template a constructor.
 */
function readPath(
	values: Record<string, unknown>,
	key: string,
): { found: boolean; value: unknown } {
	let current: unknown = values;
	for (const segment of propPath(key)) {
		if (
			PROTO_KEYS.has(segment) ||
			current === null ||
			(typeof current !== "object" && typeof current !== "function") ||
			!Object.hasOwn(current, segment)
		) {
			return { found: false, value: undefined };
		}
		current = Reflect.get(current, segment);
	}
	return { found: true, value: current };
}

function makeProps(values: Record<string, unknown>): PropsApi {
	const api: PropsApi = {
		all: () => ({ ...values }),
		get: (key, fallback) => {
			const read = readPath(values, key);
			return read.found && read.value !== undefined ? read.value : fallback;
		},
		has: (key) => readPath(values, key).found,
		only: (keys) =>
			makeProps(
				Object.fromEntries(
					keys
						.filter((k) => Object.hasOwn(values, k))
						.map((k) => [k, values[k]]),
				),
			),
		except: (keys) =>
			makeProps(
				Object.fromEntries(
					Object.entries(values).filter(([k]) => !keys.includes(k)),
				),
			),
		merge: (defaults) => makeProps(mergeProps(values, defaults)),
		// Conditional merges (Edge `mergeIf` / `mergeUnless`). The condition is
		// whatever the template hands over, so it is read for truthiness rather
		// than required to be a boolean — `$props.mergeIf($props.get('x'), …)`
		// is the documented usage and `get` returns `unknown`.
		mergeIf: (condition, defaults) =>
			condition ? makeProps(mergeProps(values, defaults)) : makeProps(values),
		mergeUnless: (condition, defaults) =>
			condition ? makeProps(values) : makeProps(mergeProps(values, defaults)),
		toAttrs: () => htmlAttrs(values),
	};
	// Each prop is also a property (`$props.title`), as Edge's ComponentProps
	// assigns them — except where a prop would hide an API method.
	for (const key of Object.keys(values)) {
		if (Object.hasOwn(api, key) || PROTO_KEYS.has(key)) continue;
		Object.defineProperty(api, key, {
			value: values[key],
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return api;
}

/** A partial's or component's name: its literal, or its expression's value. */
function* templateName(
	node: {
		readonly name: string;
		readonly name_source?: string;
		readonly line?: number;
		readonly column?: number;
	},
	scope: object,
	helpers: object,
	directive: string,
): Generator<PromiseLike<unknown>, string, unknown> {
	if (node.name_source === undefined) return node.name;
	const value = yield* evalStep(node.name_source, scope, helpers, node);
	if (typeof value !== "string" || value.length === 0) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`${directive}(${node.name_source}) must name a template with a non-empty string, got ${value === null ? "null" : typeof value}`,
			{ line: node.line, column: node.column },
		);
	}
	return value;
}

function isNodeList(value: unknown): value is readonly InkerNodeJson[] {
	return Array.isArray(value);
}

/**
 * The nodes of a partial or component: preloaded, or loaded now through
 * `ctx.loadTemplate` (a name only known at render time). A template the
 * preload found missing is reported here, where it is actually used.
 */
function* templateNodes(
	ctx: NodeRenderContext,
	kind: "partial" | "component",
	raw: string,
	key: string,
): Generator<PromiseLike<unknown>, readonly InkerNodeJson[], unknown> {
	const preloaded = (kind === "partial" ? ctx.partials : ctx.components)?.get(
		key,
	);
	if (preloaded !== undefined) return preloaded;
	const missing = (
		kind === "partial" ? ctx.missingPartials : ctx.missingComponents
	)?.get(key);
	if (missing !== undefined) throw missing;
	if (ctx.loadTemplate === undefined) {
		throw new InkerRenderError(
			"E_INKER_DISK_REQUIRED",
			`@${kind === "partial" ? "include" : "component"}('${raw}') — no template loader in this render`,
		);
	}
	const loaded = ctx.loadTemplate(kind, raw);
	const nodes = isThenable(loaded) ? yield loaded : loaded;
	if (!isNodeList(nodes)) {
		throw new InkerRenderError(
			"E_INKER_DISK_REQUIRED",
			`@${kind === "partial" ? "include" : "component"}('${raw}') — the loader returned no template`,
		);
	}
	return nodes;
}

/**
 * The props a component is called with: whatever its props expression
 * evaluates to, copied as own enumerable keys only (so an inherited or
 * swapped prototype contributes nothing). An own `__proto__` / `constructor`
 * / `prototype` key — `JSON.parse` output, a computed key — is refused.
 */
function* componentProps(
	node: Extract<InkerNodeJson, { type: "Component" }>,
	scope: object,
	helpers: object,
): Generator<PromiseLike<unknown>, Record<string, unknown>, unknown> {
	const props: Record<string, unknown> = {};
	if (node.props_source === undefined) return props;
	const value = yield* evalStep(node.props_source, scope, helpers, node);
	if (value === null || value === undefined) return props;
	if (typeof value !== "object") {
		throw new InkerRenderError(
			"E_INKER_INVALID_EXPRESSION",
			`@component props \`${node.props_source}\` must be an object, got ${typeof value}`,
			{ line: node.line, column: node.column },
		);
	}
	for (const key of Object.keys(value)) {
		if (PROTO_KEYS.has(key)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_EXPRESSION",
				`@component props key '${key}' is forbidden (prototype-pollution surface)`,
				{ line: node.line, column: node.column },
			);
		}
		props[key] = Reflect.get(value, key);
	}
	return props;
}

function* renderComponent(
	node: Extract<InkerNodeJson, { type: "Component" }>,
	scope: object,
	helpers: Record<string, unknown>,
	ctx: NodeRenderContext,
	out: string[],
): RenderStep {
	const raw = yield* templateName(node, scope, helpers, "@component");
	const key = normalizePartialKey(raw);
	const template = yield* templateNodes(ctx, "component", raw, key);
	const depth = nextDepth(ctx, `@component('${raw}')`);
	// Props evaluate in the CALLER scope and become the component's OWN scope;
	// the component does not inherit the caller's data.
	const props = yield* componentProps(node, scope, helpers);

	// `$context` — state an enclosing component provided via `@inject`, which
	// this component may extend for its own descendants. Each level gets its OWN
	// copy (Edge does the same), so a nested `@inject` never leaks back up to a
	// sibling subtree. Null-proto: context keys come from template authors.
	const $context: Record<string, unknown> = Object.assign(
		Object.create(null),
		ctx.context,
	);

	// Slot content renders in the CALLER scope; `{{> name }}` in the component
	// injects it. The default (`body`) slot is the block body outside `@slot()`.
	//
	// Rendering is DEFERRED to first use: the component's own body runs first,
	// and only then does a slot render — which is the whole point of `@inject`,
	// since the values it publishes must exist before the slot's nested
	// components look them up. The slot sees this component's `$context` while
	// keeping the caller's scope, exactly Edge's `state.$slots.$context`.
	const slotCtx: NodeRenderContext = { ...ctx, context: $context };
	// A slot renders on use, and its body may itself await — so the thunk hands
	// back a string when it finished synchronously and a promise when it did
	// not. `{{{ $slots.main() }}}` keeps working for the ordinary case, and an
	// awaiting body is reached with `{{{ await $slots.main() }}}`, as in Adonis.
	// `@slot('row', item)` binds the slot call's first argument to `item`, so
	// a list component renders each row with `$slots.row(value)` (Edge).
	const renderSlot = (
		nodes: readonly InkerNodeJson[],
		scopeName?: string,
	): ((...args: readonly unknown[]) => string | Promise<string>) => {
		return (...args) => {
			const slotOut: string[] = [];
			const slotScope =
				scopeName === undefined
					? scope
					: childScope(scope, { [scopeName]: args[0] });
			return drive(
				renderNodes(nodes, slotScope, helpers, slotCtx, slotOut),
				slotOut,
			);
		};
	};
	const slots = new Map<
		string,
		(...args: readonly unknown[]) => string | Promise<string>
	>();
	slots.set("body", renderSlot(node.body_nodes));
	for (const named of node.named_slots) {
		slots.set(named.name, renderSlot(named.nodes, named.scope));
	}

	// `$slots.main()` renders the default (body) slot; `$slots.<name>()` a named
	// slot; `$slots.<name>` is undefined when absent (so `@if($slots.footer)`
	// works). `$props` is the chainable prop API. Both are in the component scope
	// alongside the raw prop values (Edge parity, 62-4).
	// Null-proto: a `@slot('__proto__')` (which the parser's name regex allows)
	// then assigns an OWN `__proto__` key instead of mutating the object's
	// prototype — no prototype pollution.
	const $slots: Record<string, unknown> = Object.create(null);
	const asSafe = (
		html: string | Promise<string>,
	): SafeString | Promise<SafeString> =>
		isThenable(html)
			? Promise.resolve(html).then((v) => new SafeString(v))
			: new SafeString(html);
	$slots.main = () => asSafe(slots.get("body")?.() ?? "");
	for (const [name, render] of slots) {
		if (name === "body") continue;
		$slots[name] = (...args: readonly unknown[]) => asSafe(render(...args));
	}

	// `$caller` describes where the component was invoked from (Edge parity).
	// Inker carries line/column on every node; `template` is the caller's name
	// when the composer knew it. Frozen — it is diagnostic data, not a channel
	// back into the caller.
	const $caller = Object.freeze({
		line: node.line,
		col: node.column,
		// Edge names this `filename` and puts the resolved absolute path in it.
		// INKER DEVIATION (named): the LOGICAL template name goes here instead —
		// it is what `render()` was called with and what an error should quote.
		// The key keeps Edge's name so `@newError(msg, $caller.filename, …)`,
		// straight out of the Edge docs, works unchanged.
		filename: ctx.templateName,
	});
	const componentScope = {
		...ctx.sharedState,
		...props,
		$props: makeProps(props),
		$slots,
		$caller,
		$context,
		// The component's OWN name (Edge `$filename`), as `$caller.filename` is
		// the invoking template's.
		$filename: raw,
	};

	const subCtx: NodeRenderContext = {
		partials: ctx.partials,
		components: ctx.components,
		missingPartials: ctx.missingPartials,
		missingComponents: ctx.missingComponents,
		loadTemplate: ctx.loadTemplate,
		depth,
		tags: ctx.tags,
		stacks: ctx.stacks,
		sharedState: ctx.sharedState,
		slots,
		context: $context,
		// A component nested in THIS one must see this component as its caller;
		// without it `$caller.filename` was undefined one level down.
		templateName: raw,
		file: componentFile(key),
	};
	yield* renderNodes(template, componentScope, helpers, subCtx, out);
}

/** Build the helper layer and start a walk over `nodes`. */
function startWalk(
	nodes: readonly InkerNodeJson[],
	data: Record<string, unknown>,
	helpers: HelperMap,
	ctx: NodeRenderContext,
	out: string[],
): RenderStep {
	// Inker's built-in globals are always in scope; registered helpers overlay them.
	const helperObj: Record<string, unknown> = { ...INKER_GLOBALS };
	for (const [name, fn] of helpers) helperObj[name] = fn;
	// `$filename` sits in the helper layer, UNDER the render data, so a template
	// can read the name it is being rendered as without shadowing a caller's
	// own `$filename` key (Adonis scopes it the same way, as a function local).
	helperObj.$filename = ctx.templateName;
	return renderNodes(nodes, isRecord(data) ? data : {}, helperObj, ctx, out);
}

/**
 * Render a parsed template's node list against `data`, with `helpers` in scope.
 * Layout / partial / component composition is layered on top by the caller.
 *
 * SYNCHRONOUS: an expression using `await` raises rather than leaking a promise
 * into the output. `renderNodeTreeAsync` is the awaiting counterpart, which is
 * the split Adonis draws between `renderSync` and `render`.
 */
export function renderNodeTree(
	nodes: readonly InkerNodeJson[],
	data: Record<string, unknown>,
	helpers: HelperMap,
	ctx: NodeRenderContext = {},
): string {
	const out: string[] = [];
	return driveSync(
		startWalk(nodes, data, helpers, ctx, out),
		out,
		"a synchronous render",
	);
}

/** Render a node list, awaiting any expression that needs it. */
export async function renderNodeTreeAsync(
	nodes: readonly InkerNodeJson[],
	data: Record<string, unknown>,
	helpers: HelperMap,
	ctx: NodeRenderContext = {},
): Promise<string> {
	const out: string[] = [];
	return drive(startWalk(nodes, data, helpers, ctx, out), out);
}
