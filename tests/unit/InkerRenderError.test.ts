import { describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";

describe("InkerRenderError", () => {
	it("stores code, message, and structured context", () => {
		const err = new InkerRenderError("E_INKER_PARSE_ERROR", "bad token", {
			line: 2,
			column: 5,
			expression: "{{ a + b }}",
		});

		expect(err.code).toBe("E_INKER_PARSE_ERROR");
		expect(err.message).toBe("bad token");
		expect(err.context.line).toBe(2);
		expect(err.context.column).toBe(5);
		expect(err.context.expression).toBe("{{ a + b }}");
		expect(err.name).toBe("InkerRenderError");
	});

	it("preserves the underlying cause for Node 18+ semantics", () => {
		const inner = new Error("ENOENT");
		const err = new InkerRenderError(
			"E_INKER_TEMPLATE_NOT_FOUND",
			"file missing",
			{ templatePath: "/abs/x.inker" },
			{ cause: inner },
		);

		expect(err.cause).toBe(inner);
		expect(err.context.templatePath).toBe("/abs/x.inker");
	});

	it("is both InkerRenderError and Error subclass", () => {
		const err = new InkerRenderError("E_INKER_INVALID_PATH", "nope");
		expect(err instanceof InkerRenderError).toBe(true);
		expect(err instanceof Error).toBe(true);
	});

	it("freezes the context to prevent post-construction mutation", () => {
		const ctx = { line: 1, column: 1 };
		const err = new InkerRenderError("E_INKER_PARSE_ERROR", "frozen", ctx);
		expect(Object.isFrozen(err.context)).toBe(true);
	});

	it("defaults to an empty frozen context when none is provided", () => {
		const err = new InkerRenderError(
			"E_INKER_UNCLOSED_INTERPOLATION",
			"missing close",
		);
		expect(err.context).toEqual({});
		expect(Object.isFrozen(err.context)).toBe(true);
	});
});
