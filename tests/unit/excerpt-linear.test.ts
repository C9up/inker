import { describe, expect, it } from "vitest";
import { INKER_GLOBALS } from "../../src/globals.js";

// `excerpt` exists to shorten user-authored bodies, so its input is attacker
// sized: stripping tags must stay linear on `<`-heavy text (Edge's regex is
// quadratic there — a named, safer deviation).

function excerpt(value: string, length: number): unknown {
	const fn = Reflect.get(INKER_GLOBALS, "excerpt");
	if (typeof fn !== "function") throw new Error("excerpt global missing");
	return Reflect.apply(fn, undefined, [value, length, { strict: true }]);
}

describe("excerpt tag stripping", () => {
	it("handles 200,000 unclosed '<' in linear time", () => {
		const hostile = "<".repeat(200_000);
		const started = performance.now();
		excerpt(hostile, 20);
		expect(performance.now() - started).toBeLessThan(50);
	});

	it("still strips tags; a stray '<' opens a tag, as in Edge", () => {
		expect(excerpt("<p>hello <b>world</b></p>", 100)).toBe("hello world");
		expect(excerpt("a < b", 100)).toBe("a");
		expect(excerpt("x <b>y</b> <", 100)).toBe("x y");
	});
});
