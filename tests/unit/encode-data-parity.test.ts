import { describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";
import { asTyped } from "../__helpers__/bypass-type-check.js";

// Parity guards for data values that cannot cross the JSON/NAPI boundary as
// themselves. The pre-Rust TS engine handled these in `safeStringify`; the Rust
// engine receives a `serde_json::Value`, so `encodeData` must reconcile them.

function render(template: string, data: unknown): string {
	return new Templates({ root: "/tmp" }).renderString(template, asTyped(data));
}

function expectThrow(template: string, data: unknown, code: string): void {
	try {
		render(template, data);
		expect.fail("should have thrown");
	} catch (e) {
		expect(e).toBeInstanceOf(InkerRenderError);
		expect(asTyped<InkerRenderError>(e).code).toBe(code);
	}
}

describe("encodeData — bigint", () => {
	it("renders a safe-range bigint like the old String(value)", () => {
		expect(render("{{ n }}", { n: 42n })).toBe("42");
		expect(render("{{ n }}", { n: BigInt(Number.MAX_SAFE_INTEGER) })).toBe(
			String(Number.MAX_SAFE_INTEGER),
		);
	});

	it("rejects a bigint beyond MAX_SAFE_INTEGER instead of losing precision", () => {
		expectThrow("{{ n }}", { n: 2n ** 60n }, "E_INKER_INVALID_EXPRESSION");
	});
});

describe("encodeData — non-finite numbers", () => {
	it("rejects NaN rather than rendering empty", () => {
		expectThrow("{{ x }}", { x: Number.NaN }, "E_INKER_INVALID_EXPRESSION");
	});

	it("rejects Infinity rather than rendering empty", () => {
		expectThrow(
			"{{ x }}",
			{ x: Number.POSITIVE_INFINITY },
			"E_INKER_INVALID_EXPRESSION",
		);
	});
});

describe("encodeData — sparse arrays", () => {
	it("rejects a sparse hole with a typed iterable error (eager, JS-side)", () => {
		// Build a genuine hole at index 1 without sparse-literal syntax.
		const sparse: unknown[] = new Array(3);
		sparse[0] = 1;
		sparse[2] = 3;
		expectThrow(
			"{% each arr as i %}{{ i }}{% endeach %}",
			{ arr: sparse },
			"E_INKER_INVALID_ITERABLE",
		);
	});
});

describe("encodeData — undefined own-property", () => {
	it("renders undefined and null identically (empty), matching the old engine", () => {
		expect(render("[{{ x }}]", { x: undefined })).toBe("[]");
		expect(render("[{{ x }}]", { x: null })).toBe("[]");
	});

	it("treats an undefined own-property as falsy in a condition", () => {
		expect(render("{% if x %}Y{% else %}N{% endif %}", { x: undefined })).toBe(
			"N",
		);
	});
});
