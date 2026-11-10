/**
 * `await` inside a template expression — Adonis supports it on the async render
 * path (`render`) and not on the synchronous one (`renderSync`). Inker draws
 * the same line: `render()` awaits, `renderString()` raises.
 *
 * One walker serves both. It is a generator that only suspends when an
 * expression actually produced a promise, so a template with no `await` never
 * pays for the machinery.
 */
import { describe, expect, it } from "vitest";
import { hasAwaitOperator } from "../../src/awaitToken.js";
import { createTestTemplates } from "../../src/testing/index.js";

const delayed = <T>(v: T): Promise<T> =>
	new Promise((r) => setTimeout(() => r(v), 1));

describe("inker > await in expressions", () => {
	it("awaits an interpolation", async () => {
		const t = createTestTemplates({
			templates: { page: "hi {{ await who() }}" },
			helpers: new Map([["who", () => delayed("Ada")]]),
		});
		expect(await t.render("page")).toBe("hi Ada");
		t.dispose();
	});

	it("awaits an @if condition", async () => {
		const t = createTestTemplates({
			templates: { page: "@if(await ok())yes@else no@endif" },
			helpers: new Map([["ok", () => delayed(true)]]),
		});
		expect(await t.render("page")).toBe("yes");
		t.dispose();
	});

	it("awaits an @each iterable, then renders each item", async () => {
		const t = createTestTemplates({
			templates: { page: "@each(n in await rows())[{{ n }}]@endeach" },
			helpers: new Map([["rows", () => delayed([1, 2, 3])]]),
		});
		expect(await t.render("page")).toBe("[1][2][3]");
		t.dispose();
	});

	it("awaits inside a loop body, per iteration", async () => {
		const t = createTestTemplates({
			templates: { page: "@each(n in [1, 2])({{ await twice(n) }})@endeach" },
			helpers: new Map([["twice", (n: unknown) => delayed(Number(n) * 2)]]),
		});
		expect(await t.render("page")).toBe("(2)(4)");
		t.dispose();
	});

	it("awaits in @let, and the binding is the resolved value", async () => {
		const t = createTestTemplates({
			templates: { page: "@let(u = await user()){{ u.name }}" },
			helpers: new Map([["user", () => delayed({ name: "Ada" })]]),
		});
		expect(await t.render("page")).toBe("Ada");
		t.dispose();
	});

	it("awaits through a component and its props", async () => {
		const t = createTestTemplates({
			templates: {
				"components/card": "<c>{{ title }}</c>",
				page: "@!component('card', { title: await who() })",
			},
			helpers: new Map([["who", () => delayed("Ada")]]),
		});
		expect(await t.render("page")).toBe("<c>Ada</c>");
		t.dispose();
	});

	it("awaits inside a component template", async () => {
		const t = createTestTemplates({
			templates: {
				"components/card": "<c>{{ await who() }}</c>",
				page: "@!component('card')",
			},
			helpers: new Map([["who", () => delayed("Ada")]]),
		});
		expect(await t.render("page")).toBe("<c>Ada</c>");
		t.dispose();
	});

	it("awaits a slot body through {{{ await $slots.main() }}}", async () => {
		const t = createTestTemplates({
			templates: {
				"components/wrap": "[{{{ await $slots.main() }}}]",
				page: "@component('wrap'){{ await who() }}@endcomponent",
			},
			helpers: new Map([["who", () => delayed("Ada")]]),
		});
		expect(await t.render("page")).toBe("[Ada]");
		t.dispose();
	});

	it("keeps a sync slot working without await", async () => {
		const t = createTestTemplates({
			templates: {
				"components/wrap": "[{{{ $slots.main() }}}]",
				page: "@component('wrap')plain@endcomponent",
			},
		});
		expect(await t.render("page")).toBe("[plain]");
		t.dispose();
	});

	it("raises on the synchronous path, as renderSync does in Adonis", () => {
		const t = createTestTemplates({
			helpers: new Map([["who", () => delayed("Ada")]]),
		});
		expect(() => t.renderString("{{ await who() }}")).toThrow(
			/cannot use `await`/,
		);
		t.dispose();
	});

	it("does not mistake an identifier containing 'await' for the keyword", async () => {
		const t = createTestTemplates({
			templates: { page: "{{ awaited }}{{ o.await_at }}" },
		});
		expect(await t.render("page", { awaited: "x", o: { await_at: "y" } })).toBe(
			"xy",
		);
		t.dispose();
	});
});

describe("inker > the word await inside a literal", () => {
	it("renders synchronously when await only appears in a string", () => {
		const t = createTestTemplates({
			templates: {
				single: "{{ 'please await (this)' }}",
				double: '{{ "await x" }}',
			},
		});
		expect(t.engine.renderSync("single")).toBe("please await (this)");
		expect(t.engine.renderSync("double")).toBe("await x");
		t.dispose();
	});

	it("renders synchronously when await only appears in a template literal's text", () => {
		const t = createTestTemplates({
			templates: { page: ["{{ `await $", "{a}` }}"].join("") },
		});
		expect(t.engine.renderSync("page", { a: 1 })).toBe("await 1");
		t.dispose();
	});

	it("still awaits inside a template literal's substitution", async () => {
		const t = createTestTemplates({
			templates: { page: ["{{ `n=$", "{await one()}` }}"].join("") },
			helpers: new Map([["one", () => delayed(1)]]),
		});
		expect(await t.render("page")).toBe("n=1");
		t.dispose();
	});

	it("still refuses a real await in a synchronous render", () => {
		const t = createTestTemplates({
			templates: { page: "{{ await p }}" },
		});
		expect(() =>
			t.engine.renderSync("page", { p: Promise.resolve(1) }),
		).toThrow(/cannot use `await`/);
		t.dispose();
	});
});

describe("inker > await only as a real token selects the async compiler", () => {
	it.each([
		["a regex literal", "{{ /await /.test('await ') }}", {}, "true"],
		[
			"a regex with a class and an escaped slash",
			"{{ /[/]await \\/ x/.source }}",
			{},
			"[/]await \\/ x",
		],
		["a block comment", "{{ /* await x */ 1 }}", {}, "1"],
		["a line comment", "{{ 1 // await x\n }}", {}, "1"],
		[
			"a property named await",
			"{{ o.await + o?.await }}",
			{ o: { await: 2 } },
			"4",
		],
		["an object key named await", "{{ ({ await: 3 }).await }}", {}, "3"],
		[
			"a division, not a regex",
			"{{ a / 2 / await_ }}",
			{ a: 8, await_: 2 },
			"2",
		],
		["a regex after a keyword", "{{ typeof /await x/ }}", {}, "object"],
		[
			"a nested template in a substitution",
			["{{ `$", "{`await $", "{a}`}` }}"].join(""),
			{ a: 1 },
			"await 1",
		],
	])(
		"renders synchronously with await in %s",
		(_label, template, data, expected) => {
			const t = createTestTemplates({ templates: { page: template } });
			expect(t.engine.renderSync("page", data)).toBe(expected);
			t.dispose();
		},
	);

	it.each([
		["after a regex literal", "{{ /x/.test('x') && await one() }}", "1"],
		["after a comment", "{{ /* note */ await one() }}", "1"],
		["after a division", "{{ 4 / 2 + await one() }}", "3"],
		[
			"in a nested template substitution",
			["{{ `$", "{`n=$", "{await one()}`}` }}"].join(""),
			"n=1",
		],
		["followed by a parenthesis", "{{ await (one()) }}", "1"],
		["followed by a bracket", "{{ (await [one()])[0] }}", "1"],
	])("still awaits %s", async (_label, template, expected) => {
		const t = createTestTemplates({
			templates: { page: template },
			helpers: new Map([["one", () => delayed(1)]]),
		});
		expect(await t.render("page")).toBe(expected);
		expect(() => t.engine.renderSync("page")).toThrow(/cannot use `await`/);
		t.dispose();
	});
});

describe("hasAwaitOperator", () => {
	it.each([
		["await p", true],
		["a ? await p : b", true],
		["x++ / 2 / await p", true],
		["[await p]", true],
		["'await p'", false],
		["/* await p */ 1", false],
		["a / await_ / b", false],
		["x++ / await_ / 2", false],
		["{ await: 1 }", false],
		["{ await }", false],
		["await => 1", false],
		["o?.await", false],
		["/[\\]/]await p/", false],
		[["`$", "{'`'}await p`"].join(""), false],
	])("%s → %s", (source, expected) => {
		expect(hasAwaitOperator(source)).toBe(expected);
	});

	it.each([
		["slashes", `${"/".repeat(200_000)} await`],
		["unclosed substitutions", `${"`${".repeat(100_000)} await`],
		["unclosed comments", `${"/*".repeat(100_000)} await`],
	])("stays linear on %s", (_label, hostile) => {
		const started = performance.now();
		hasAwaitOperator(hostile);
		expect(performance.now() - started).toBeLessThan(100);
	});
});
