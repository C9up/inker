import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";

// `@component(name, props)` takes any JavaScript expression for the props
// and for the name, and `@include` any expression for the name, as in Edge.
// Expected outputs are edge.js 6.5.1's for the same source.

function withFiles(files: Record<string, string>): Templates {
	const root = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-args-")),
	);
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(root, `${name}.inker`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, source);
	}
	return new Templates({ root, cacheMode: "never" });
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof InkerRenderError) return e.code;
		throw e;
	}
	throw new Error("expected an InkerRenderError");
}

const data = { a: 1, list: [1, 2], user: { name: "ada" } };

describe("component props as a JavaScript expression", () => {
	it.each([
		["an identifier value", "{ v: a }", "[1]"],
		["an array literal", "{ v: [1, 2] }", "[1,2]"],
		["a method call", "{ v: user.name.toUpperCase() }", "[ADA]"],
		["arithmetic", "{ v: a + 1 }", "[2]"],
		["a ternary", "{ v: a ? 'y' : 'n' }", "[y]"],
		// Joined so the test source holds no `${` inside a plain string.
		["a template literal", ["{ v: `x$", "{a}` }"].join(""), "[x1]"],
	])("accepts %s", async (_label, props, expected) => {
		const t = withFiles({
			"components/v": "[{{ v }}]",
			page: `@!component('v', ${props})`,
		});
		expect(await t.render("page", data)).toBe(expected);
	});

	it("takes a props variable, a quoted key and a spread", async () => {
		const t = withFiles({
			"components/btn": "<button {{ $props.toAttrs() }}></button>",
			cvar: "@!component('btn', props)",
			strkey: "@!component('btn', { 'aria-label': 'x' })",
			spread: "@!component('btn', { ...props, id: 'k' })",
		});
		const props = { type: "button", title: "t" };
		expect(await t.render("cvar", { props })).toBe(
			'<button type="button" title="t"></button>',
		);
		expect(await t.render("strkey")).toBe('<button aria-label="x"></button>');
		expect(await t.render("spread", { props })).toBe(
			'<button type="button" title="t" id="k"></button>',
		);
	});

	it("still refuses a prototype-pollution key", async () => {
		const t = withFiles({
			"components/v": "[{{ v }}]",
			literal: "@!component('v', { __proto__: { v: 1 } })",
			computed: "@!component('v', { ['__proto__']: 1 })",
			parsed: "@!component('v', JSON.parse(raw))",
		});
		expect(await codeOf(() => t.render("literal"))).toBe(
			"E_INKER_INVALID_EXPRESSION",
		);
		expect(await codeOf(() => t.render("computed"))).toBe(
			"E_INKER_INVALID_EXPRESSION",
		);
		expect(
			await codeOf(() =>
				t.render("parsed", { raw: '{"__proto__": {"v": 1}}' }),
			),
		).toBe("E_INKER_INVALID_EXPRESSION");
	});

	it("rejects props that are not an object", async () => {
		const t = withFiles({
			"components/v": "[{{ v }}]",
			page: "@!component('v', 42)",
		});
		expect(await codeOf(() => t.render("page"))).toBe(
			"E_INKER_INVALID_EXPRESSION",
		);
	});
});

describe("dynamic template names", () => {
	it("includes a partial named by an expression", async () => {
		const t = withFiles({
			"partials/x": "X",
			page: "@include(which)",
			cond: "@includeIf(true, which)",
		});
		expect(await t.render("page", { which: "partials/x" })).toBe("X");
		expect(t.renderSync("page", { which: "partials/x" })).toBe("X");
		expect(await t.render("cond", { which: "partials/x" })).toBe("X");
	});

	it("renders a component named by an expression", async () => {
		const t = withFiles({
			"components/b": "B{{ n }}",
			page: "@!component(comp, { n: 1 })",
			block: "@component(`b`)body@end",
		});
		expect(await t.render("page", { comp: "b" })).toBe("B1");
		expect(await t.render("block")).toBe("B");
	});

	it("loads what a dynamically named template includes in turn", async () => {
		const t = withFiles({
			"partials/outer": "[@include('partials/inner')@!component('c')]",
			"partials/inner": "in",
			"components/c": "C",
			page: "@include(which)",
		});
		expect(await t.render("page", { which: "partials/outer" })).toBe("[inC]");
	});

	it("keeps the containment rules on a dynamic name", async () => {
		const t = withFiles({
			page: "@include(which)",
			comp: "@!component(which)",
		});
		expect(await codeOf(() => t.render("page", { which: "../secret" }))).toBe(
			"E_INKER_INVALID_PATH",
		);
		expect(await codeOf(() => t.render("comp", { which: "../x" }))).toBe(
			"E_INKER_INVALID_PATH",
		);
		expect(await codeOf(() => t.render("page", { which: 42 }))).toBe(
			"E_INKER_INVALID_PATH",
		);
	});
});

// The name and the props are split on the first top-level comma, found by a
// JavaScript-aware scan: a comma, bracket or quote inside a template literal,
// a nested `${}` substitution, a string, a regex or a comment is not one.
describe("splitting a component name from its props", () => {
	// `#{` stands for a template literal's `${` in these template sources.
	const js = (source: string): string =>
		source.replaceAll("#{", ["$", "{"].join(""));

	function card(page: string): Templates {
		return withFiles({
			"components/card,primary": "P{{ value }}",
			"components/card,}x": "Q{{ value }}",
			"components/it's": "S{{ value }}",
			page,
		});
	}

	it.each([
		[
			"a comma in a template literal name",
			"@!component(`card,#{kind}`, { value: 1 })",
			"P1",
		],
		[
			"a nested template in the substitution",
			"@!component(`card,#{`#{kind}`}`, { value: 2 })",
			"P2",
		],
		[
			"a call with commas in the substitution",
			"@!component(`card,#{[kind, 'x'].join(',').split(',')[0]}`, { value: 3 })",
			"P3",
		],
		[
			"a brace in a string in the substitution",
			"@!component(`card,#{'}'}x`, { value: 4 })",
			"Q4",
		],
		[
			"an escaped backtick",
			"@!component(`card,\\`#{kind}`.replace('`', ''), { value: 5 })",
			"P5",
		],
		["a quote in the template text", "@!component(`it's`, { value: 6 })", "S6"],
		[
			"a comment holding a comma",
			"@!component(/* a, b */ `card,#{kind}`, { value: 7 })",
			"P7",
		],
		[
			"a regex holding a comma in the name",
			"@!component(/,/.test(sep) ? `card#{sep}#{kind}` : 'x', { value: 8 })",
			"P8",
		],
		[
			"a regex holding a comma in the props",
			"@!component('card,primary', /a,b/.test(sep) || { value: 9 })",
			"P9",
		],
	])("handles %s", async (_label, source, expected) => {
		const t = card(js(source));
		expect(await t.render("page", { kind: "primary", sep: "," })).toBe(
			expected,
		);
	});

	it("splits @includeIf after a condition holding a template literal", async () => {
		const t = withFiles({
			"partials/x": "X",
			page: js("@includeIf(`a,#{b}` === 'a,1', `partials/#{which}`)"),
		});
		expect(await t.render("page", { b: 1, which: "x" })).toBe("X");
	});

	it("still reports props after a second top-level comma", async () => {
		const t = card(js("@!component(`card,#{kind}`, { value: 1 }, extra)"));
		expect(await codeOf(() => t.render("page", { kind: "primary" }))).toBe(
			"E_INKER_INVALID_EXPRESSION",
		);
	});
});

describe("slots with a scope argument", () => {
	it("binds the argument the component passes to the slot", async () => {
		const t = withFiles({
			"components/list": "@each(i in items){{{ $slots.row(i) }}}@endeach",
			page: "@component('list', { items: [1, 2] })@slot('row', item)<li>{{ item }}</li>@endslot@endcomponent",
		});
		expect(await t.render("page")).toBe("<li>1</li><li>2</li>");
	});

	it("leaves the name unbound when the slot is called without it", async () => {
		const t = withFiles({
			"components/once": "{{{ $slots.row() }}}",
			page: "@component('once')@slot('row', item)[{{ item }}]@end@end",
		});
		expect(await t.render("page")).toBe("[]");
	});
});
