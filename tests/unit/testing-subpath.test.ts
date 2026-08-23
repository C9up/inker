/**
 * `@c9up/inker/testing` — the subpath the docs have promised for a while and
 * that did not exist. It renders through the real engine (containment checks
 * included) with the templates held in memory.
 */
import { describe, expect, it } from "vitest";
import { createTestTemplates } from "../../src/testing/index.js";

describe("inker > @c9up/inker/testing", () => {
	it("renders a template registered in memory", async () => {
		const t = createTestTemplates({ templates: { page: "hi {{ name }}" } });
		expect(await t.render("page", { name: "Ada" })).toBe("hi Ada");
		t.dispose();
	});

	it("composes a layout, a partial and a component, all in memory", async () => {
		const t = createTestTemplates({
			templates: {
				"layouts/main": "<main>{{> body }}@include('partials/foot')</main>",
				"partials/foot": "<f/>",
				"components/badge": "<b>{{{ $slots.main() }}}</b>",
				page: "@layout('layouts/main')@component('badge')hi@endcomponent",
			},
		});
		expect(await t.render("page")).toBe("<main><b>hi</b><f/></main>");
		t.dispose();
	});

	it("takes helpers and globals", async () => {
		const t = createTestTemplates({
			templates: { page: "{{ shout(site) }}" },
			helpers: new Map([["shout", (v: unknown) => `${String(v)}!`]]),
			globals: { site: "ream" },
		});
		expect(await t.render("page")).toBe("ream!");
		t.dispose();
	});

	it("renders a bare source string too", () => {
		const t = createTestTemplates();
		expect(t.renderString("{{ 1 + 1 }}")).toBe("2");
		t.dispose();
	});

	it("exposes the engine for anything the shorthands miss", async () => {
		const t = createTestTemplates({ templates: { page: "@icon()" } });
		t.engine.registerTag({
			tagName: "icon",
			block: false,
			seekable: false,
			compile(_p, buffer) {
				buffer.writeRaw("<svg/>");
			},
		});
		expect(await t.render("page")).toBe("<svg/>");
		t.dispose();
	});

	it("keeps the engine contained — a traversing name is refused", async () => {
		const t = createTestTemplates();
		await expect(t.render("../escape")).rejects.toThrow();
		t.dispose();
	});

	it("dispose is safe to call twice", () => {
		const t = createTestTemplates();
		t.dispose();
		expect(() => t.dispose()).not.toThrow();
	});
});
