import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { EDGE_GLOBAL_NAMES } from "../../src/globals.js";
import { type InkerNodeJson, renderNodeTree } from "../../src/renderNode.js";

const require = createRequire(import.meta.url);
const native: {
	parseTemplateJson: (
		src: string,
		helpers: readonly string[],
		customTags: readonly string[],
	) => string;
} = require("../../index.linux-x64-gnu.node");

function render(source: string, data: Record<string, unknown> = {}): string {
	// Declare the global names so bare `{{ camelCase(x) }}` calls parse.
	const ast: { nodes: InkerNodeJson[] } = JSON.parse(
		native.parseTemplateJson(source, [...EDGE_GLOBAL_NAMES], []),
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
		expect(render("{{ excerpt('<p>hello <b>world</b></p>', 5) }}")).toBe("hello…");
	});

	it("nl2br returns raw HTML (SafeString)", () => {
		expect(render("{{ nl2br('a\\nb') }}")).toBe("a<br>b");
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
		expect(render("{{ html.classNames('btn', { active: on, off: no }) }}", { on: true, no: false })).toBe(
			"btn active",
		);
		expect(render("{{ html.attrs({ class: 'c', hidden: yes, skip: no }) }}", { yes: true, no: false })).toBe(
			'class="c" hidden',
		);
		expect(render("{{ html.safe('<i>x</i>') }}")).toBe("<i>x</i>");
	});

	it("html.attrs drops unsafe attribute NAMES (attribute-injection guard)", () => {
		// The value is escaped; an injection-shaped KEY must be dropped, not emitted
		// verbatim into the raw SafeString.
		expect(
			render("{{ html.attrs(o) }}", { o: { id: "ok", "x onload=alert(1)": "y", "a<b": "z" } }),
		).toBe('id="ok"');
	});

	it("a registered helper can override a global", () => {
		const ast: { nodes: InkerNodeJson[] } = JSON.parse(
			native.parseTemplateJson("{{ truncate('x') }}", [...EDGE_GLOBAL_NAMES], []),
		);
		const out = renderNodeTree(ast.nodes, {}, new Map([["truncate", () => "OVERRIDDEN"]]));
		expect(out).toBe("OVERRIDDEN");
	});
});
