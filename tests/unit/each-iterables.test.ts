import os from "node:os";
import { describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";

// `@each` iterates what Edge's `each` iterates: arrays, strings (per code
// point) and any object's own entries, with no key filtered out. Map and Set
// are inker extensions.

function render(source: string, data: Record<string, unknown> = {}): string {
	return new Templates({ root: os.tmpdir() }).renderString(source, data);
}

describe("@each iterables", () => {
	it("iterates a string per character with a numeric index", () => {
		expect(
			render("@each((c, i) in s){{ i }}{{ c }},@endeach", { s: "ab" }),
		).toBe("0a,1b,");
	});

	it("iterates an emoji string per code point", () => {
		expect(render("@each(c in s)[{{ c }}]@endeach", { s: "a😀" })).toBe(
			"[a][😀]",
		);
	});

	it("keeps an own key named constructor", () => {
		expect(
			render("@each((v, k) in car){{ k }}={{ v }};@endeach", {
				car: { constructor: "Toyota", model: "Yaris" },
			}),
		).toBe("constructor=Toyota;model=Yaris;");
	});

	it("binds an own __proto__ key without touching any prototype", () => {
		const parsed: Record<string, unknown> = JSON.parse(
			'{"__proto__": {"polluted": true}, "a": 1}',
		);
		expect(
			render("@each((v, k) in o){{ k }};@endeach{{ ({}).polluted }}", {
				o: parsed,
			}),
		).toBe("__proto__;a;");
		expect(Reflect.get({}, "polluted")).toBeUndefined();
	});
});
