import { EDGE_GLOBALS, htmlAttrs } from "./globals.js";
import { InkerRenderError } from "./InkerRenderError.js";
import { SafeString } from "./SafeString.js";

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
			readonly line?: number;
			readonly column?: number;
	  }
	| { readonly type: "Layout"; readonly name: string }
	| { readonly type: "Partial"; readonly name: string }
	| { readonly type: "Slot"; readonly name: string }
	| {
			readonly type: "Component";
			readonly name: string;
			readonly args: readonly {
				readonly key: string;
				readonly source: string;
			}[];
			readonly body_nodes: readonly InkerNodeJson[];
			readonly named_slots: readonly {
				readonly name: string;
				readonly nodes: readonly InkerNodeJson[];
			}[];
	  }
	| {
			readonly type: "Section";
			readonly name: string;
			readonly body_nodes: readonly InkerNodeJson[];
	  }
	| { readonly type: "Super" }
	| {
			readonly type: "Eval";
			readonly source: string;
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "Dump";
			readonly source: string;
			readonly line?: number;
			readonly column?: number;
	  }
	| {
			readonly type: "CustomTag";
			readonly name: string;
			readonly args_source: string;
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
	readonly loc: { readonly start: { readonly line: number; readonly col: number } };
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
		escape: boolean,
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
	compile(
		parser: InkerTagParser,
		buffer: InkerTagBuffer,
		token: InkerTagToken,
	): void;
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

// Compile-once cache: expression source → a JS fn evaluating it with helpers +
// scope in scope (`with` — a `new Function` body is non-strict).
const exprCache = new Map<string, CompiledExpr>();

function compileExpr(source: string): CompiledExpr {
	const cached = exprCache.get(source);
	if (cached !== undefined) return cached;
	let fn: CompiledExpr;
	try {
		// `new Function` — the author-controlled template expression compiled to a
		// V8 closure (Edge model); the source comes from `.inker` files, not user
		// input, so this is the same trust level as the rest of the app's code.
		// `$g` (the global shadow) is outermost, then helpers `$h`, then scope `$s`.
		const compiled = new Function(
			"$g",
			"$h",
			"$s",
			`with($g){ with($h){ with($s){ return (${source}); } } }`,
		);
		fn = (s, h) => compiled(SANDBOX_SHADOW, h, s);
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
		const msg = errMessage(cause);
		// A bare unknown identifier / navigating into null/undefined maps to the
		// same typed code the retired Rust path resolver produced.
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

/** Stringify a scalar for interpolation (parity with the Rust `safe_stringify`). */
function stringifyScalar(v: unknown, source: string): string {
	switch (typeof v) {
		case "string":
			return v;
		case "number":
			return String(v); // JS renders integer floats without `.0`, `-0` → "0"
		case "boolean":
			return v ? "true" : "false";
		case "bigint":
			return v.toString();
		default:
			throw new InkerRenderError(
				"E_INKER_INVALID_EXPRESSION",
				`cannot interpolate a ${Array.isArray(v) ? "array" : typeof v} value from \`${source}\``,
			);
	}
}

export interface NodeRenderContext {
	/** Layout body-injection target for `{{> body }}`. */
	readonly bodyHtml?: string;
	/** Component slot content by name; `{{> name }}` resolves from here. */
	readonly slots?: ReadonlyMap<string, string>;
	/** Pre-loaded `@include` partials by normalized key → their node list. */
	readonly partials?: ReadonlyMap<string, readonly InkerNodeJson[]>;
	/** Pre-loaded `@component` templates by normalized key → their node list. */
	readonly components?: ReadonlyMap<string, readonly InkerNodeJson[]>;
	/** Rendered `@section` content by name (child fills, injected at layout yields). */
	readonly sections?: ReadonlyMap<string, string>;
	/** Layout's default content for the section currently being rendered (`@super`). */
	readonly superHtml?: string;
	/** Runtime-registered custom tags; a `@<name>(...)` resolves its handler here. */
	readonly tags?: TagMap;
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

// ---- The walker ----

/** Render a list of sibling nodes, threading `@let` bindings forward. */
function renderNodes(
	nodes: readonly InkerNodeJson[],
	data: object,
	helpers: object,
	ctx: NodeRenderContext,
	out: string[],
): void {
	let scope = data;
	for (const node of nodes) {
		if (node.type === "Let") {
			const value = evalExpr(node.source, scope, helpers, node);
			scope = { ...scope, [node.name]: value };
			continue;
		}
		renderNode(node, scope, helpers, ctx, out);
	}
}

function renderNode(
	node: InkerNodeJson,
	scope: object,
	helpers: object,
	ctx: NodeRenderContext,
	out: string[],
): void {
	switch (node.type) {
		case "Text":
			out.push(node.value);
			return;
		case "Interpolation": {
			const v = evalExpr(node.source, scope, helpers, node);
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
			const v = evalExpr(node.condition.source, scope, helpers, node);
			if (v) {
				renderNodes(node.then_nodes, scope, helpers, ctx, out);
			} else if (node.else_nodes) {
				renderNodes(node.else_nodes, scope, helpers, ctx, out);
			}
			return;
		}
		case "Each":
			renderEach(node, scope, helpers, ctx, out);
			return;
		case "Slot": {
			if (ctx.slots?.has(node.name)) {
				const html = ctx.slots.get(node.name);
				if (html !== undefined) out.push(html);
			} else if (node.name === "body" && ctx.bodyHtml !== undefined) {
				out.push(ctx.bodyHtml);
			}
			// unknown slot → empty (Edge parity)
			return;
		}
		case "Partial": {
			// `@include('name')` renders the partial's nodes in the SAME scope.
			const partial = ctx.partials?.get(normalizePartialKey(node.name));
			if (partial === undefined) {
				throw new InkerRenderError(
					"E_INKER_DISK_REQUIRED",
					`@include('${node.name}') — partial not loaded (composer must preload it)`,
				);
			}
			renderNodes(partial, scope, helpers, ctx, out);
			return;
		}
		case "Component":
			renderComponent(node, scope, helpers, ctx, out);
			return;
		case "Section": {
			// In a layout, a `@section('name')` is a yield: inject the child's
			// filled content if present, else render the layout's default body.
			// In a standalone template (no layout), it just renders inline.
			const filled = ctx.sections?.get(node.name);
			if (filled !== undefined) {
				out.push(filled);
			} else {
				renderNodes(node.body_nodes, scope, helpers, ctx, out);
			}
			return;
		}
		case "Super":
			// Inside a child section: the layout's default content for it.
			if (ctx.superHtml !== undefined) out.push(ctx.superHtml);
			return;
		case "Eval":
			// Evaluate for side effects (e.g. a helper call); emit nothing.
			evalExpr(node.source, scope, helpers, node);
			return;
		case "Dump": {
			// Pretty-print the value for debugging (Edge `@dump`).
			const value = evalExpr(node.source, scope, helpers, node);
			let json: string;
			try {
				json = JSON.stringify(value, null, 2) ?? String(value);
			} catch {
				json = String(value);
			}
			out.push(`<pre class="inker-dump">${escapeHtml(json)}</pre>`);
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
				filename: "",
				loc: { start: { line: node.line ?? 0, col: node.column ?? 0 } },
			};
			const buffer: InkerTagBuffer = {
				writeRaw: (text) => {
					out.push(text);
				},
				outputExpression: (expr, _filename, line, escape) => {
					const v = evalExpr(expr, scope, helpers, { line, column: node.column });
					if (v instanceof SafeString) {
						out.push(v.value);
					} else if (v === null || v === undefined) {
						// renders empty
					} else if (escape) {
						out.push(escapeHtml(stringifyScalar(v, expr)));
					} else {
						out.push(stringifyScalar(v, expr));
					}
				},
			};
			tag.compile(TAG_PARSER, buffer, token);
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

function renderEach(
	node: Extract<InkerNodeJson, { type: "Each" }>,
	scope: object,
	helpers: object,
	ctx: NodeRenderContext,
	out: string[],
): void {
	const iterable = evalExpr(node.iterable_source, scope, helpers, node);

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
	} else if (isRecord(iterable)) {
		for (const [k, val] of Object.entries(iterable)) {
			if (k === "__proto__" || k === "constructor" || k === "prototype")
				continue;
			entries.push([val, k]);
		}
	} else {
		// A null/undefined iterable is the common "maybe-absent value" mistake —
		// point at the `@if()` guard (parity with the Rust hint).
		const hint =
			iterable === null || iterable === undefined
				? " — wrap the loop in `@if()` to guard a possibly-absent value"
				: "";
		throw new InkerRenderError(
			"E_INKER_INVALID_ITERABLE",
			`@each iterable \`${node.iterable_source}\` is not an array or object${hint}`,
		);
	}

	if (entries.length === 0) {
		if (node.else_nodes) renderNodes(node.else_nodes, scope, helpers, ctx, out);
		return;
	}

	const binding = node.binding;
	for (const [value, key] of entries) {
		let childScope: object;
		if ("Single" in binding) {
			childScope = { ...scope, [binding.Single]: value };
		} else if ("Destructured" in binding) {
			const [kName, vName] = binding.Destructured;
			// array-of-pairs: `value` is `[k, v]`; object/Map/Set: key + value.
			childScope =
				arrayOfPairs && Array.isArray(value)
					? { ...scope, [kName]: value[0], [vName]: value[1] }
					: { ...scope, [kName]: key, [vName]: value };
		} else {
			childScope = {
				...scope,
				[binding.Indexed.item]: value,
				[binding.Indexed.index]: key,
			};
		}
		renderNodes(node.body_nodes, childScope, helpers, ctx, out);
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
	toAttrs(): SafeString;
}

function mergeProps(
	values: Record<string, unknown>,
	defaults: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...values };
	for (const [key, val] of Object.entries(defaults)) {
		if (key === "class" && typeof val === "string" && typeof out.class === "string") {
			out.class = `${val} ${out.class}`.trim(); // classes are combined (Edge)
		} else if (!Object.hasOwn(out, key)) {
			out[key] = val; // caller props win; defaults fill gaps
		}
	}
	return out;
}

function makeProps(values: Record<string, unknown>): PropsApi {
	return {
		all: () => ({ ...values }),
		get: (key, fallback) => (Object.hasOwn(values, key) ? values[key] : fallback),
		has: (key) => Object.hasOwn(values, key),
		only: (keys) =>
			makeProps(
				Object.fromEntries(
					keys.filter((k) => Object.hasOwn(values, k)).map((k) => [k, values[k]]),
				),
			),
		except: (keys) =>
			makeProps(Object.fromEntries(Object.entries(values).filter(([k]) => !keys.includes(k)))),
		merge: (defaults) => makeProps(mergeProps(values, defaults)),
		toAttrs: () => htmlAttrs(values),
	};
}

function renderComponent(
	node: Extract<InkerNodeJson, { type: "Component" }>,
	scope: object,
	helpers: object,
	ctx: NodeRenderContext,
	out: string[],
): void {
	const template = ctx.components?.get(normalizePartialKey(node.name));
	if (template === undefined) {
		throw new InkerRenderError(
			"E_INKER_DISK_REQUIRED",
			`@component('${node.name}') — component not loaded (composer must preload it)`,
		);
	}
	// Args evaluate in the CALLER scope and become the component's OWN scope
	// (props); the component does not inherit the caller's data.
	const props: Record<string, unknown> = {};
	for (const arg of node.args)
		props[arg.key] = evalExpr(arg.source, scope, helpers);

	// Slot content renders in the CALLER scope; `{{> name }}` in the component
	// injects it. The default (`body`) slot is the block body outside `@slot()`.
	const slots = new Map<string, string>();
	const bodyOut: string[] = [];
	renderNodes(node.body_nodes, scope, helpers, ctx, bodyOut);
	slots.set("body", bodyOut.join(""));
	for (const named of node.named_slots) {
		const slotOut: string[] = [];
		renderNodes(named.nodes, scope, helpers, ctx, slotOut);
		slots.set(named.name, slotOut.join(""));
	}

	// `$slots.main()` renders the default (body) slot; `$slots.<name>()` a named
	// slot; `$slots.<name>` is undefined when absent (so `@if($slots.footer)`
	// works). `$props` is the chainable prop API. Both are in the component scope
	// alongside the raw prop values (Edge parity, 62-4).
	// Null-proto: a `@slot('__proto__')` (which the parser's name regex allows)
	// then assigns an OWN `__proto__` key instead of mutating the object's
	// prototype — no prototype pollution.
	const $slots: Record<string, unknown> = Object.create(null);
	$slots.main = () => new SafeString(slots.get("body") ?? "");
	for (const [name, html] of slots) {
		if (name === "body") continue;
		$slots[name] = () => new SafeString(html);
	}

	const componentScope = { ...props, $props: makeProps(props), $slots };

	const subCtx: NodeRenderContext = {
		partials: ctx.partials,
		components: ctx.components,
		tags: ctx.tags,
		slots,
	};
	renderNodes(template, componentScope, helpers, subCtx, out);
}

/**
 * Render a parsed template's node list against `data`, with `helpers` in scope.
 * Layout / partial / component composition is layered on top by the caller.
 */
export function renderNodeTree(
	nodes: readonly InkerNodeJson[],
	data: Record<string, unknown>,
	helpers: HelperMap,
	ctx: NodeRenderContext = {},
): string {
	// Edge-core globals are always in scope; registered helpers overlay them.
	const helperObj: Record<string, unknown> = { ...EDGE_GLOBALS };
	for (const [name, fn] of helpers) helperObj[name] = fn;
	const out: string[] = [];
	renderNodes(nodes, isRecord(data) ? data : {}, helperObj, ctx, out);
	return out.join("");
}
