import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Exception } from "@c9up/flare";
import { afterAll, describe, expect, it } from "vitest";
import { errors, InkerError, Templates } from "../../src/index.js";
import { inTemplate, isInkerError } from "../../src/inkerError.js";

// The real path: the message names the resolved file, and the temp directory is
// a symlink on macOS (/var -> /private/var) and a short 8.3 name on Windows.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "inker-errors-")));
writeFileSync(join(root, "broken.inker"), "<p>\n  @if(user)\n</p>");
writeFileSync(join(root, "page.inker"), "<h1>Hi</h1>\n<p>{{ user.name }}</p>");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function caught(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		return err;
	}
	return expect.unreachable("the call should have thrown");
}

describe("InkerError", () => {
	it("has EdgeError's shape: code, line, col, filename, and a template frame", () => {
		const err = new InkerError("bad token", "E_INKER_PARSE_ERROR", {
			line: 2,
			col: 5,
			filename: "pages/home",
		});

		expect(err).toBeInstanceOf(InkerError);
		expect(err).toBeInstanceOf(Exception);
		expect(err).toMatchObject({
			message: "bad token",
			code: "E_INKER_PARSE_ERROR",
			line: 2,
			col: 5,
			filename: "pages/home",
			status: 500,
		});
		expect(err.stack?.split("\n")[1]).toBe("    at anonymous (pages/home:2:5)");
		expect(isInkerError(err)).toBe(true);
		expect(isInkerError(new Error("plain"))).toBe(false);
	});

	it("keeps the cause it is given", () => {
		const inner = new Error("boom");
		const err = new InkerError(
			"helper threw",
			"E_INKER_HELPER_THROW",
			{ line: 1, col: 1, filename: "x" },
			{ cause: inner },
		);
		expect(err.cause).toBe(inner);
	});

	it("is placed in a template once, keeping its stack and cause", () => {
		const inner = new Error("boom");
		const err = new InkerError(
			"no position yet",
			"E_INKER_INVALID_EXPRESSION",
			{ line: 0, col: 0, filename: "" },
			{ cause: inner },
		);
		const placed = inTemplate(err, { line: 3, col: 7, filename: "card" });

		expect(placed).toMatchObject({ line: 3, col: 7, filename: "card" });
		expect(placed.cause).toBe(inner);
		expect(placed.stack?.split("\n")[1]).toBe("    at anonymous (card:3:7)");
		expect(placed.stack?.split("\n").slice(2)).toEqual(
			err.stack?.split("\n").slice(2),
		);
		// Already placed: returned as it is.
		expect(inTemplate(placed, { line: 9, col: 9, filename: "other" })).toBe(
			placed,
		);
	});

	it("locates a parse error in the template file", () => {
		const err = caught(() => new Templates({ root }).compile("broken"));

		expect(err).toBeInstanceOf(InkerError);
		if (!isInkerError(err)) return;
		expect(err.code).toBe("E_INKER_UNCLOSED_BLOCK");
		expect(err).toMatchObject({ line: 2, col: 3, filename: "broken" });
		expect(err.stack?.split("\n")[1]).toBe("    at anonymous (broken:2:3)");
	});

	it("locates a render error in the template file", () => {
		const err = caught(() => new Templates({ root }).renderSync("page"));

		expect(err).toBeInstanceOf(InkerError);
		if (!isInkerError(err)) return;
		expect(err.code).toBe("E_INKER_UNKNOWN_IDENTIFIER");
		expect(err).toMatchObject({ line: 2, filename: "page" });
		expect(err.col).toBeGreaterThan(0);
		expect(err.stack?.split("\n")[1]).toBe(
			`    at anonymous (page:2:${err.col})`,
		);
	});
});

describe("errors", () => {
	it("is a namespace of flare exceptions for what a call refuses", () => {
		const err = new errors.E_INKER_NOT_BOOTED(["start the provider first"]);

		expect(err).toBeInstanceOf(Exception);
		expect(err).toBeInstanceOf(errors.E_INKER_NOT_BOOTED);
		expect(err).not.toBeInstanceOf(InkerError);
		expect(err).toMatchObject({
			code: "E_INKER_NOT_BOOTED",
			status: 500,
			message: "start the provider first",
		});
	});

	it("keeps the cause it is given", () => {
		const inner = new Error("ENOENT");
		const err = new errors.E_INKER_TEMPLATE_NOT_FOUND(
			["Template not found: /abs/x.inker"],
			{ cause: inner },
		);
		expect(err.cause).toBe(inner);
	});

	it("is what a missing template raises, with its path in the message", () => {
		const err = caught(() => new Templates({ root }).renderSync("missing"));

		expect(err).toBeInstanceOf(errors.E_INKER_TEMPLATE_NOT_FOUND);
		expect(err).toMatchObject({
			code: "E_INKER_TEMPLATE_NOT_FOUND",
			message: `Template not found: ${join(root, "missing.inker")}`,
		});
	});
});
