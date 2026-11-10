import { describe, expect, it } from "vitest";
import { INKER_GLOBAL_NAMES } from "../../src/globals.js";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { getNative } from "../../src/loadNapi.js";
import { type InkerNodeJson, renderNodeTree } from "../../src/renderNode.js";

// Load the native binary through the platform-aware loader (picks the right
// `index.<suffix>.node` per OS/arch) — never a hardcoded platform path.
const native = getNative();

function render(source: string, data: Record<string, unknown> = {}): string {
	// Declare the global names so bare `{{ camelCase(x) }}` calls parse.
	const ast: { nodes: InkerNodeJson[] } = JSON.parse(
		native.parseTemplateJson(source, [...INKER_GLOBAL_NAMES], [], [], "", []),
	);
	return renderNodeTree(ast.nodes, data, new Map());
}

describe("Edge-core globals (62-7)", () => {
	it("case conversion", () => {
		expect(render("{{ camelCase('hello world') }}")).toBe("helloWorld");
		expect(render("{{ pascalCase('hello world') }}")).toBe("HelloWorld");
		expect(render("{{ snakeCase('helloWorld') }}")).toBe("hello_world");
		expect(render("{{ dashCase('helloWorld') }}")).toBe("hello-world");
		expect(render("{{ titleCase('hello world') }}")).toBe("Hello World");
	});

	it("truncate + excerpt", () => {
		expect(render("{{ truncate('a long string here', 6) }}")).toBe("a long...");
		expect(render("{{ truncate('short', 20) }}")).toBe("short");
		expect(render("{{ excerpt('<p>hello <b>world</b></p>', 5) }}")).toBe(
			"hello...",
		);
	});

	// Expected outputs are edge.js 6.5.1's: whole words unless `strict`, and
	// a "..." suffix.
	it.each([
		["{{ truncate('hello wonderful world', 8) }}", "hello wonderful..."],
		[
			"{{ truncate('hello wonderful world', 8, { strict: true }) }}",
			"hello wo...",
		],
		[
			"{{ truncate('hello wonderful world', 8, { completeWords: false }) }}",
			"hello wo...",
		],
		[
			"{{ truncate('hello wonderful world', 8, { suffix: ' [more]' }) }}",
			"hello wonderful [more]",
		],
		["{{ truncate('hello wonderful', 5) }}", "hello..."],
		["{{ truncate('  padded text here  ', 6) }}", "padded..."],
		["{{ truncate('short', 20) }}", "short"],
		["{{ excerpt('<p>hello wonderful world</p>', 8) }}", "hello wonderful..."],
		[
			"{{ excerpt('<p>hello wonderful world</p>', 8, { strict: true }) }}",
			"hello wo...",
		],
		["{{ excerpt('a<br>b<!-- note -->c', 20) }}", "a bc"],
		["{{ excerpt('short', 20) }}", "short"],
	])("%s renders as Edge does", (source, expected) => {
		expect(render(source)).toBe(expected);
	});

	it("nl2br turns newlines into breaks", () => {
		expect(render("{{ nl2br('a\\nb') }}")).toBe("a<br>b");
	});

	// nl2br exists to print the multi-line text a user typed, so its input is
	// hostile by default. Marking the whole result safe made `{{ }}` — the form
	// that reads as escaped — emit that input as live markup.
	it("nl2br escapes the text it breaks", () => {
		expect(
			render("{{ nl2br(c) }}", { c: "hi\n<img src=x onerror=alert(1)>" }),
		).toBe("hi<br>&lt;img src=x onerror=alert(1)&gt;");
	});

	it("nl2br still lets html.safe through, which is the opt-in", () => {
		expect(render("{{ nl2br(html.safe(c)) }}", { c: "a\n<b>x</b>" })).toBe(
			"a<br><b>x</b>",
		);
	});

	// A class list built from a request used to close the attribute it sat in.
	it("html.classNames cannot break out of the attribute", () => {
		expect(
			render('<i class="{{ html.classNames(c) }}"></i>', {
				c: 'a" onmouseover="alert(1)',
			}),
		).toBe('<i class="a&quot; onmouseover=&quot;alert(1)"></i>');
	});

	it("pluralize", () => {
		expect(render("{{ pluralize('item', 2) }}")).toBe("items");
		expect(render("{{ pluralize('item', 1) }}")).toBe("item");
		expect(render("{{ pluralize('person', 3) }}")).toBe("people");
		expect(render("{{ pluralize('category', 2) }}")).toBe("categories");
	});

	it("number formatting", () => {
		expect(render("{{ prettyBytes(0) }}")).toBe("0 B");
		expect(render("{{ prettyBytes(1000) }}")).toBe("1 kB");
		expect(render("{{ prettyMs(500) }}")).toBe("500ms");
		expect(render("{{ prettyMs(60000) }}")).toBe("1m");
		expect(render("{{ ordinal(1) }}")).toBe("1st");
		expect(render("{{ ordinal(2) }}")).toBe("2nd");
		expect(render("{{ ordinal(11) }}")).toBe("11th");
		expect(render("{{ ordinal(21) }}")).toBe("21st");
	});

	it("html helpers return raw HTML", () => {
		expect(
			render("{{ html.classNames('btn', { active: on, off: no }) }}", {
				on: true,
				no: false,
			}),
		).toBe("btn active");
		expect(
			render("{{ html.attrs({ class: 'c', hidden: yes, skip: no }) }}", {
				yes: true,
				no: false,
			}),
		).toBe('class="c" hidden');
		expect(render("{{ html.safe('<i>x</i>') }}")).toBe("<i>x</i>");
	});

	it("html.attrs drops unsafe attribute NAMES (attribute-injection guard)", () => {
		// The value is escaped; an injection-shaped KEY must be dropped, not emitted
		// verbatim into the raw SafeString.
		expect(
			render("{{ html.attrs(o) }}", {
				o: { id: "ok", "x onload=alert(1)": "y", "a<b": "z" },
			}),
		).toBe('id="ok"');
	});

	it("the case helpers Edge ships that inker had not implemented", () => {
		expect(render("{{ capitalCase('hello world') }}")).toBe("Hello World");
		expect(render("{{ sentenceCase('hello-World') }}")).toBe("Hello world");
		expect(render("{{ noCase('helloWorld') }}")).toBe("hello world");
		expect(render("{{ dotCase('hello world') }}")).toBe("hello.world");
	});

	it("titleCase keeps the small words lower-case", () => {
		// Edge runs the `title-case` rules: only `capitalCase` capitalises all.
		expect(render("{{ titleCase('a tale of two cities') }}")).toBe(
			"A Tale of Two Cities",
		);
		expect(render("{{ capitalCase('a tale of two cities') }}")).toBe(
			"A Tale Of Two Cities",
		);
	});

	it("sentence joins a list the way prose would", () => {
		expect(render("{{ sentence(l) }}", { l: [] })).toBe("");
		expect(render("{{ sentence(l) }}", { l: ["one"] })).toBe("one");
		expect(render("{{ sentence(l) }}", { l: ["one", "two"] })).toBe(
			"one and two",
		);
		expect(render("{{ sentence(l) }}", { l: ["one", "two", "three"] })).toBe(
			"one, two, and three",
		);
	});

	it("toMs and toBytes reverse the pretty formatters", () => {
		expect(render("{{ toMs('1h') }}")).toBe("3600000");
		expect(render("{{ toMs('2.5 days') }}")).toBe("216000000");
		expect(render("{{ toBytes('1kb') }}")).toBe("1000");
		expect(render("{{ toBytes('1KiB') }}")).toBe("1024");
		expect(render("{{ toMs('nonsense') }}")).toBe("");
	});

	it("html.escape never returns less escaped than `{{ }}` does", () => {
		// `html.escape` returns a plain string, so `{{ }}` would escape it a second
		// time — Edge behaves the same; the explicit escape pairs with `{{{ }}}`.
		expect(render("{{{ html.escape(v) }}}", { v: "<a href='x'>&`" })).toBe(
			"&lt;a href=&#39;x&#39;&gt;&amp;&#96;",
		);
	});

	it("html.escape passes a SafeString through", () => {
		expect(render("{{{ html.escape(html.safe('<b>hi</b>')) }}}")).toBe(
			"<b>hi</b>",
		);
	});

	it("js.stringify is safe to embed in a <script> block", () => {
		// A plain JSON.stringify would emit `</script>` verbatim and close the tag.
		expect(render("{{{ js.stringify(v) }}}", { v: { a: "</script>" } })).toBe(
			'{"a":"\\u003C/script\\u003E"}',
		);
	});

	it("html.jsonLd writes a JSON-LD script no value can end", () => {
		const product = {
			"@context": "https://schema.org",
			"@type": "Product",
			name: "</script><script>alert(1)</script>",
		};
		const out = render("{{ html.jsonLd(p, nonce) }}", {
			p: product,
			nonce: 'n"1',
		});
		expect(out).toBe(
			'<script type="application/ld+json" nonce="n&quot;1">{"@context":"https://schema.org","@type":"Product","name":"\\u003C/script\\u003E\\u003Cscript\\u003Ealert(1)\\u003C/script\\u003E"}</script>',
		);
		const json = out.slice(out.indexOf(">") + 1, out.lastIndexOf("</script>"));
		expect(JSON.parse(json)).toEqual(product);
	});

	it("html.jsonLd writes no nonce without one, and nothing for no value", () => {
		expect(render("{{ html.jsonLd(p) }}", { p: { "@type": "Thing" } })).toBe(
			'<script type="application/ld+json">{"@type":"Thing"}</script>',
		);
		expect(
			render("{{ html.jsonLd(p, '') }}", { p: { "@type": "Thing" } }),
		).not.toContain("nonce");
		expect(render("{{ html.jsonLd(p) }}", { p: null })).toBe("");
	});

	it("html.jsonLd refuses a value JSON cannot hold instead of writing it", () => {
		const cyclic: Record<string, unknown> = { "@type": "Thing" };
		cyclic.self = cyclic;
		const cases: [string, unknown][] = [
			["a function", () => 1],
			["a symbol", Symbol("x")],
			["a bigint", { "@type": "Product", sku: 1n }],
			["NaN", { "@type": "Product", weight: Number.NaN }],
			["Infinity", { "@type": "Offer", price: [Number.POSITIVE_INFINITY] }],
			["a function", { "@type": "Thing", name: () => "x" }],
			["a cycle", cyclic],
		];
		for (const [what, p] of cases) {
			let caught: unknown;
			try {
				render("{{ html.jsonLd(p) }}", { p });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(InkerRenderError);
			if (caught instanceof InkerRenderError) {
				expect(caught.code).toBe("E_INKER_INVALID_JSON_LD");
				expect(caught.message).toContain(what);
			}
		}
	});

	function jsonLdError(p: unknown): InkerRenderError {
		try {
			render("{{ html.jsonLd(p) }}", { p });
		} catch (error) {
			if (error instanceof InkerRenderError) return error;
			throw error;
		}
		throw new Error("html.jsonLd did not throw");
	}

	it("html.jsonLd names the full path of a value JSON cannot hold", () => {
		const offer = {
			"@type": "Product",
			offers: [{ price: 1 }, { "@type": "Offer", price: Number.NaN }],
		};
		const error = jsonLdError(offer);
		expect(error.code).toBe("E_INKER_INVALID_JSON_LD");
		expect(error.message).toBe(
			"html.jsonLd: offers[1].price is NaN, which JSON-LD cannot hold",
		);
		// A key that is not an identifier is quoted, so the path stays readable.
		expect(
			jsonLdError({ "@graph": [{ "x-y": { z: [1, () => 2] } }] }).message,
		).toBe(
			'html.jsonLd: ["@graph"][0]["x-y"].z[1] is a function, which JSON-LD cannot hold',
		);
		expect(jsonLdError({ a: { b: 1n } }).message).toBe(
			"html.jsonLd: a.b is a bigint, which JSON-LD cannot hold",
		);
	});

	it("html.jsonLd names the path of a cycle and what it points back to", () => {
		const seller: Record<string, unknown> = { name: "S" };
		const product = { "@type": "Product", offers: [{ seller }] };
		seller.product = product;
		const error = jsonLdError(product);
		expect(error.code).toBe("E_INKER_INVALID_JSON_LD");
		expect(error.message).toBe(
			"html.jsonLd: offers[0].seller.product is a cycle back to the value, which JSON-LD cannot hold",
		);
		const inner: Record<string, unknown> = {};
		inner.self = inner;
		expect(jsonLdError({ a: [inner] }).message).toBe(
			"html.jsonLd: a[0].self is a cycle back to a[0], which JSON-LD cannot hold",
		);
	});

	it("html.jsonLd writes a value seen twice that is not a cycle", () => {
		const shared = { "@id": "#org" };
		expect(
			render("{{ html.jsonLd(p) }}", { p: { a: shared, b: [shared] } }),
		).toBe(
			'<script type="application/ld+json">{"a":{"@id":"#org"},"b":[{"@id":"#org"}]}</script>',
		);
	});

	it("html.jsonLd reports a throwing getter or toJSON as such, not as a cycle", () => {
		const getter = {
			"@type": "Thing",
			nested: {
				get name(): string {
					throw new Error("getter failed");
				},
			},
		};
		const fromGetter = jsonLdError(getter);
		expect(fromGetter.code).toBe("E_INKER_HELPER_THROW");
		expect(fromGetter.message).toBe(
			"html.jsonLd: reading nested.name threw: getter failed",
		);
		expect(fromGetter.message).not.toContain("cycle");
		expect(fromGetter.cause).toBeInstanceOf(Error);

		const fromToJson = jsonLdError({
			list: [
				{
					toJSON(): never {
						throw new TypeError("toJSON failed");
					},
				},
			],
		});
		expect(fromToJson.code).toBe("E_INKER_HELPER_THROW");
		expect(fromToJson.message).toBe(
			"html.jsonLd: the toJSON of list[0] threw: toJSON failed",
		);
	});

	it("html.jsonLd validates what toJSON returns, at the path it replaces", () => {
		expect(
			jsonLdError({
				offer: { price: { toJSON: () => Number.POSITIVE_INFINITY } },
			}).message,
		).toBe("html.jsonLd: offer.price is Infinity, which JSON-LD cannot hold");
	});

	it("html.jsonLd writes what JSON writes for undefined, boxed values and toJSON(key)", () => {
		expect(
			render("{{ html.jsonLd(p) }}", {
				p: {
					gone: undefined,
					list: [undefined, 1],
					boxed: [Object(2), Object("s"), Object(true)],
					keyed: { toJSON: (key: string) => `key:${key}` },
				},
			}),
		).toBe(
			'<script type="application/ld+json">{"list":[null,1],"boxed":[2,"s",true],"keyed":"key:keyed"}</script>',
		);
	});

	it("html.jsonLd keeps a __proto__ key as data", () => {
		expect(
			render("{{ html.jsonLd(p) }}", {
				p: JSON.parse('{"__proto__":{"a":1}}'),
			}),
		).toBe('<script type="application/ld+json">{"__proto__":{"a":1}}</script>');
	});

	it("html.jsonLd refuses a value nested too deep instead of overflowing", () => {
		let deep: unknown = 1;
		for (let i = 0; i < 100_000; i++) deep = [deep];
		const error = jsonLdError(deep);
		expect(error.code).toBe("E_INKER_INVALID_JSON_LD");
		expect(error.message).toContain("nested deeper than");
	});

	it("html.jsonLd still writes what toJSON gives, a Date as its ISO string", () => {
		expect(
			render("{{ html.jsonLd(p) }}", {
				p: {
					"@type": "Event",
					startDate: new Date(Date.UTC(2026, 0, 1)),
					url: new URL("https://a.example/e"),
				},
			}),
		).toBe(
			'<script type="application/ld+json">{"@type":"Event","startDate":"2026-01-01T00:00:00.000Z","url":"https://a.example/e"}</script>',
		);
	});

	it("a registered helper can override a global", () => {
		const ast: { nodes: InkerNodeJson[] } = JSON.parse(
			native.parseTemplateJson(
				"{{ truncate('x') }}",
				[...INKER_GLOBAL_NAMES],
				[],
				[],
				"",
				[],
			),
		);
		const out = renderNodeTree(
			ast.nodes,
			{},
			new Map([["truncate", () => "OVERRIDDEN"]]),
		);
		expect(out).toBe("OVERRIDDEN");
	});
});
