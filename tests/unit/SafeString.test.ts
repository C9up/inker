import { describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { SafeString } from "../../src/SafeString.js";
import { asTyped } from "../__helpers__/bypass-type-check.js";

describe("SafeString", () => {
	it("wraps a string value as an already-escaped marker", () => {
		const wrapped = new SafeString("<input>");
		expect(wrapped.value).toBe("<input>");
		expect(wrapped instanceof SafeString).toBe(true);
	});

	it("preserves the empty string", () => {
		const wrapped = new SafeString("");
		expect(wrapped.value).toBe("");
	});

	it("rejects non-string values with InkerRenderError (typed-error contract)", () => {
		// R7: switched from native TypeError to InkerRenderError so callers
		// handling the typed-error contract uniformly catch SafeString
		// construction failures alongside every other Inker failure mode.
		expect(() => new SafeString(asTyped<string>(42))).toThrow(InkerRenderError);
		expect(() => new SafeString(asTyped<string>(null))).toThrow(
			InkerRenderError,
		);
		expect(() => new SafeString(asTyped<string>(undefined))).toThrow(
			InkerRenderError,
		);
	});

	it("instanceof returns false for plain strings", () => {
		const plain: unknown = "<input>";
		expect(plain instanceof SafeString).toBe(false);
	});

	it("exposes value as a readonly own property", () => {
		const wrapped = new SafeString("hello");
		expect(Object.hasOwn(wrapped, "value")).toBe(true);
		expect(wrapped.value).toBe("hello");
	});
});
