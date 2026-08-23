/**
 * `{{ inspect(record) }}` returned a SafeString wrapping raw JSON, so any HTML
 * inside the inspected data executed — a stored XSS reachable from a debug view
 * left in a template. Edge escapes here too (`htmlSafe(inspect.string.html())`).
 */
import { describe, expect, it } from "vitest";
import { createTestTemplates } from "../../src/testing/index.js";

describe("inker > inspect escaping", () => {
	it("does not let inspected data close a tag", async () => {
		const t = createTestTemplates({
			templates: { page: "{{ inspect(user) }}" },
		});
		const out = await t.render("page", {
			user: { bio: "<img src=x onerror=alert(1)>" },
		});
		expect(out).not.toContain("<img");
		expect(out).toContain("&lt;img");
		t.dispose();
	});

	it("still shows the data, formatted", async () => {
		const t = createTestTemplates({
			templates: { page: "{{ inspect(user) }}" },
		});
		const out = await t.render("page", { user: { name: "Ada", age: 36 } });
		expect(out).toContain("Ada");
		expect(out).toContain("36");
		t.dispose();
	});

	it("escapes the fallback too, when JSON cannot render the value", async () => {
		// A BigInt makes JSON.stringify throw, so inspect falls back to String().
		const t = createTestTemplates({
			templates: { page: "{{ inspect(value) }}" },
		});
		const out = await t.render("page", {
			value: { toString: () => "<script>alert(1)</script>", big: 1n },
		});
		expect(out).not.toContain("<script>");
		t.dispose();
	});
});
