import { describe, expect, it } from "vitest";
import { INKER_GLOBAL_NAMES } from "../../src/globals.js";
import { getNative } from "../../src/loadNapi.js";
import { type InkerNodeJson, renderNodeTree } from "../../src/renderNode.js";

// Load the native binary through the platform-aware loader (picks the right
// `index.<suffix>.node` per OS/arch) — never a hardcoded platform path.
const native = getNative();

function render(source: string, data: Record<string, unknown> = {}): string {
	// Declare the global names so bare `{{ camelCase(x) }}` calls parse.
	const ast: { nodes: InkerNodeJson[] } = JSON.parse(
		native.parseTemplateJson(source, [...INKER_GLOBAL_NAMES], [], [], ""),
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
		expect(render("{{ truncate('a long string here', 6) }}")).toBe("a long…");
		expect(render("{{ truncate('short', 20) }}")).toBe("short");
		expect(render("{{ excerpt('<p>hello <b>world</b></p>', 5) }}")).toBe(
			"hello…",
		);
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

	it("a registered helper can override a global", () => {
		const ast: { nodes: InkerNodeJson[] } = JSON.parse(
			native.parseTemplateJson(
				"{{ truncate('x') }}",
				[...INKER_GLOBAL_NAMES],
				[],
				[],
				"",
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
