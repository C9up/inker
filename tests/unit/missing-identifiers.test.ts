import os from "node:os";
import { describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";

// A name the render data does not carry reads as `undefined`, as in Edge,
// where every non-local identifier compiles to `state.<name>`. Optional data
// (`errors`, `flashMessages`) is guarded with `@if(name)`.

function render(source: string, data: Record<string, unknown> = {}): string {
	return new Templates({ root: os.tmpdir() }).renderString(source, data);
}

function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof InkerRenderError) return e.code;
		throw e;
	}
	throw new Error("expected an InkerRenderError");
}

describe("missing identifiers", () => {
	it("prints a missing name as empty", () => {
		expect(render("[{{ missing }}]")).toBe("[]");
		expect(render("[{{{ missing }}}]")).toBe("[]");
	});

	it("takes the else branch of @if(missing)", () => {
		expect(render("@if(missing)yes@else\nno@endif")).toBe("no");
		expect(render("{{ typeof missing }}")).toBe("undefined");
		expect(render("{{ missing ?? 'fallback' }}")).toBe("fallback");
	});

	it("still throws when navigating into a missing name", () => {
		expect(codeOf(() => render("{{ missing.x }}"))).toBe(
			"E_INKER_UNKNOWN_IDENTIFIER",
		);
	});

	it("keeps the @if() hint for @each over a missing name", () => {
		try {
			render("@each(x in missing){{ x }}@endeach");
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(InkerRenderError);
			if (e instanceof InkerRenderError) {
				expect(e.code).toBe("E_INKER_INVALID_ITERABLE");
				expect(e.message).toContain("@if()");
			}
		}
	});

	it("keeps the dangerous Node globals undefined", () => {
		expect(render("[{{ process }}|{{ require }}|{{ globalThis }}]")).toBe(
			"[||]",
		);
	});

	it("still resolves JavaScript's own globals", () => {
		expect(render("{{ Math.max(1, 2) }}|{{ JSON.stringify([1]) }}")).toBe(
			"2|[1]",
		);
	});

	it("does not leak an assignment to a missing name onto globalThis", () => {
		render("@eval(inkerLeakProbe = 1)");
		expect(Reflect.has(globalThis, "inkerLeakProbe")).toBe(false);
	});

	it("lets @assign create a binding the data does not carry", () => {
		// Edge compiles `@assign(ghost = 1)` to `state.ghost = 1`.
		const data: Record<string, unknown> = {};
		expect(render("@assign(ghost = 1){{ ghost }}", data)).toBe("1");
		expect(data).toEqual({});
	});

	it("resolves a missing name inside an arrow function", () => {
		expect(render("{{ [1, 2].map(n => n + (offset ?? 0)).join() }}")).toBe(
			"1,2",
		);
	});
});
