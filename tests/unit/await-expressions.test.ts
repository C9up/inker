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
