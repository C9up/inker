import { describe, expect, it } from "vitest";
import { getNative } from "../../src/loadNapi.js";
import {
	type HelperMap,
	type InkerNodeJson,
	renderNodeTree,
	type TagMap,
} from "../../src/renderNode.js";
import { SafeString } from "../../src/SafeString.js";

// The Node renderer consumes the JSON AST from the Rust `parseTemplateJson`
// export, loaded through the platform-aware loader (never a hardcoded
// `index.<suffix>.node` path — that broke every non-linux-x64 CI leg).
const native = getNative();

function render(
	source: string,
	data: Record<string, unknown>,
	helpers: HelperMap = new Map(),
	tags: TagMap = new Map(),
): string {
	const ast: { nodes: InkerNodeJson[] } = JSON.parse(
		native.parseTemplateJson(
			source,
			[...helpers.keys()],
			[...tags.keys()],
			[],
			"",
		),
	);
	return renderNodeTree(ast.nodes, data, helpers, { tags });
}

describe("Node renderer (62-2 pivot — eval in V8, no QuickJS)", () => {
	it("text + escaped interpolation", () => {
		expect(render("Hi {{ name }}", { name: "<b>&'" })).toBe(
			"Hi &lt;b&gt;&amp;&#39;",
		);
	});

	it("raw interpolation {{{ }}} does not escape", () => {
		expect(render("{{{ html }}}", { html: "<b>x</b>" })).toBe("<b>x</b>");
	});

	it("full-JS: method calls + array methods + arrow fns", () => {
		expect(
			render("{{ items.map(i => i.n).join('-') }}", {
				items: [{ n: 1 }, { n: 2 }, { n: 3 }],
			}),
		).toBe("1-2-3");
	});

	it("ternary + arithmetic", () => {
		expect(render("{{ n > 1 ? n * 2 : 0 }}", { n: 5 })).toBe("10");
	});

	it("@if / @else on a rich condition", () => {
		const src =
			"@if(users.filter(u => u.active).length > 0)some@else none@endif";
		expect(render(src, { users: [{ active: false }, { active: true }] })).toBe(
			"some",
		);
		expect(render(src, { users: [{ active: false }] })).toBe(" none");
	});

	it("@each over an array with @let and index binding", () => {
		const src =
			"@each((row, i) in rows)@let(n = i + 1){{ n }}:{{ row.name }};@endeach";
		expect(render(src, { rows: [{ name: "a" }, { name: "b" }] })).toBe(
			"1:a;2:b;",
		);
	});

	it("@each over an object (value, key)", () => {
		expect(
			render("@each((v, k) in obj){{ k }}={{ v }};@endeach", {
				obj: { a: 1, b: 2 },
			}),
		).toBe("a=1;b=2;");
	});

	it("THE killer case — a helper called INSIDE a rich expression (loop-scoped arg)", () => {
		// `keep` is a plain function in scope; V8 calls it during `.filter` with
		// the loop-scoped `u`. This is what QuickJS could not do without an
		// unsafe FFI bridge — here it is free.
		const helpers: HelperMap = new Map([
			["keep", (u: unknown) => (u as { id: number }).id % 2 === 0],
		]);
		expect(
			render(
				"{{ users.filter(u => keep(u)).map(u => u.id).join(',') }}",
				{
					users: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
				},
				helpers,
			),
		).toBe("2,4");
	});

	it("a helper returning SafeString is emitted raw", () => {
		// `[icon()][0]` is a rich (Raw) expression whose result IS the SafeString
		// instance → emitted raw, not escaped.
		const helpers: HelperMap = new Map([
			["icon", () => new SafeString("<svg/>")],
		]);
		expect(render("{{ [icon()][0] }}", {}, helpers)).toBe("<svg/>");
	});

	it("unknown identifier → typed error", () => {
		expect(() => render("{{ nope.x }}", {})).toThrowError(
			/E_INKER_UNKNOWN_IDENTIFIER|not defined/,
		);
	});

	it("@dump pretty-prints a value for debugging (Edge @dump)", () => {
		const out = render("@dump(user)", { user: { name: "Ada", n: 2 } });
		// The JSON is HTML-escaped inside the debug <pre> (quotes → &quot;).
		expect(out).toBe(
			'<pre class="inker-dump">{\n  &quot;name&quot;: &quot;Ada&quot;,\n  &quot;n&quot;: 2\n}</pre>',
		);
	});

	it("@eval runs an expression for side effects, emitting nothing (62-8)", () => {
		const calls: string[] = [];
		const helpers: HelperMap = new Map([
			[
				"rec",
				(v: unknown) => {
					calls.push(String(v));
					return "";
				},
			],
		]);
		const ast: { nodes: InkerNodeJson[] } = JSON.parse(
			native.parseTemplateJson(
				"@eval(rec('a'))kept@eval(rec('b'))",
				["rec"],
				[],
				[],
				"",
			),
		);
		expect(renderNodeTree(ast.nodes, {}, helpers)).toBe("kept");
		expect(calls).toEqual(["a", "b"]);
	});

	it("@<tagName>(jsArg) — a registered custom tag, buffer.writeRaw (Edge @svg)", () => {
		// `@svg` reads its verbatim jsArg (Edge `token.properties.jsArg`) and writes
		// raw markup via `buffer.writeRaw` — no expression evaluation.
		const tags: TagMap = new Map([
			[
				"svg",
				{
					tagName: "svg",
					block: false,
					seekable: true,
					compile(_parser, buffer, token) {
						const name = token.properties.jsArg.trim().replace(/['"]/g, "");
						buffer.writeRaw(`<svg data-icon="${name}"/>`);
					},
				},
			],
		]);
		expect(render("@svg('user')", {}, new Map(), tags)).toBe(
			'<svg data-icon="user"/>',
		);
	});

	it("buffer.outputExpression evaluates a template expression in scope (Edge @time)", () => {
		// The expression source is evaluated in V8 with the render scope in scope.
		const tags: TagMap = new Map([
			[
				"upperName",
				{
					tagName: "upperName",
					block: false,
					seekable: false,
					compile(_parser, buffer, token) {
						buffer.outputExpression(
							"name.toUpperCase()",
							token.filename,
							1,
							true,
						);
					},
				},
			],
		]);
		expect(render("@upperName()", { name: "ada" }, new Map(), tags)).toBe(
			"ADA",
		);
	});

	it("a seekable:false tag rejects arguments", () => {
		const tags: TagMap = new Map([
			[
				"hr",
				{
					tagName: "hr",
					block: false,
					seekable: false,
					compile(_p, buffer) {
						buffer.writeRaw("<hr/>");
					},
				},
			],
		]);
		expect(() => render("@hr('x')", {}, new Map(), tags)).toThrowError(
			/does not accept arguments|seekable/,
		);
	});

	it("an unregistered @tag at render time → typed error", () => {
		// Parsed as a custom tag (name passed to the parser) but no tag wired.
		const ast: { nodes: InkerNodeJson[] } = JSON.parse(
			native.parseTemplateJson("@svg('x')", [], ["svg"], [], ""),
		);
		expect(() =>
			renderNodeTree(ast.nodes, {}, new Map(), { tags: new Map() }),
		).toThrowError(/E_INKER_UNKNOWN_TAG|no tag registered/);
	});

	it("dangerous Node globals are shadowed to undefined in the eval scope (hardening)", () => {
		// `process` / `globalThis` / `require` resolve to undefined, not the real
		// Node globals — blocks the easy secret-leak / RCE while staying full-JS.
		expect(render("{{ globalThis }}", {})).toBe(""); // undefined → empty
		expect(() => render("{{ process.env.SECRET }}", {})).toThrowError(
			/E_INKER_UNKNOWN_IDENTIFIER|cannot read propert/i,
		);
		expect(() => render("{{ require('fs') }}", {})).toThrowError(/E_INKER/);
	});

	it("a legitimate data/helper name still wins over the global shadow", () => {
		// The shadow is the OUTERMOST scope, so real data named `process` is used.
		expect(render("{{ process.tier }}", { process: { tier: "prod" } })).toBe(
			"prod",
		);
	});

	it("@each([k, v] in object) binds key+value even when a value is an array (P2)", () => {
		// Regression: the pair-vs-entry decision must key off the ITERABLE kind,
		// not the element shape — an object value that is an array is not a pair.
		expect(
			render("@each([k, v] in obj){{ k }}={{ v.join('/') }};@endeach", {
				obj: { home: [1, 2], away: [3, 4] },
			}),
		).toBe("home=1/2;away=3/4;");
	});

	it("@each([k, v] in arrayOfPairs) still destructures each pair", () => {
		expect(
			render("@each([k, v] in rows){{ k }}:{{ v }};@endeach", {
				rows: [
					["a", 1],
					["b", 2],
				],
			}),
		).toBe("a:1;b:2;");
	});
});

describe("@let destructuring (62-2 Edge parity)", () => {
	it("object destructuring binds each key into scope", () => {
		expect(
			render("@let({ name, email } = user){{ name }} <{{ email }}>", {
				user: { name: "Ada", email: "ada@x.io" },
			}),
		).toBe("Ada <ada@x.io>");
	});

	it("array destructuring with a rest element", () => {
		expect(
			render(
				"@let([first, second, ...rest] = items){{ first }}/{{ second }}/{{ rest.join(',') }}",
				{
					items: [1, 2, 3, 4],
				},
			),
		).toBe("1/2/3,4");
	});

	it("object rename `key: local` binds the local name", () => {
		expect(render("@let({ a: b } = obj){{ b }}", { obj: { a: 7 } })).toBe("7");
	});

	it("object destructuring with a rest element", () => {
		expect(
			render("@let({ a, ...rest } = obj){{ a }}/{{ rest.b }},{{ rest.c }}", {
				obj: { a: 1, b: 2, c: 3 },
			}),
		).toBe("1/2,3");
	});

	it("shorthand default fills a missing key", () => {
		expect(
			render("@let({ role = 'guest' } = user){{ role }}", { user: {} }),
		).toBe("guest");
	});

	it("the right-hand side can be a full-JS expression using a helper", () => {
		const helpers: HelperMap = new Map([["pair", () => ({ x: 1, y: 2 })]]);
		expect(render("@let({ x, y } = pair()){{ x }},{{ y }}", {}, helpers)).toBe(
			"1,2",
		);
	});

	it("destructured bindings are block-scoped to following siblings (Edge)", () => {
		// The binding threads forward through @let, exactly like the simple form.
		expect(
			render("@let({ a } = o){{ a }}@let({ b } = o){{ b }}", {
				o: { a: "A", b: "B" },
			}),
		).toBe("AB");
	});

	it("nested @let destructuring inside an @each loop scope", () => {
		expect(
			render(
				"@each(u in users)@let({ id, tag } = u)[{{ id }}:{{ tag }}]@endeach",
				{
					users: [
						{ id: 1, tag: "x" },
						{ id: 2, tag: "y" },
					],
				},
			),
		).toBe("[1:x][2:y]");
	});

	it("rejects a prototype-pollution binding name at parse", () => {
		expect(() =>
			render("@let({ __proto__ } = payload)ok", { payload: {} }),
		).toThrowError(/prototype-pollution/i);
	});
});
