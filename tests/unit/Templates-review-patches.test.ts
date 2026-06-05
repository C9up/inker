import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";
import { asTyped, bypassTypeCheck } from "../__helpers__/bypass-type-check.js";

function makeTempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "inker-review-"));
}

describe("Templates — name validation (P1+P3)", () => {
	let root: string;

	beforeEach(() => {
		root = makeTempRoot();
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("rejects path traversal via '..' in name", async () => {
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("../../etc/passwd", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(InkerRenderError);
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
		}
	});

	it("rejects absolute name", async () => {
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("/etc/passwd", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
		}
	});

	it("rejects name containing NUL byte", async () => {
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("foo\u0000bar", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(InkerRenderError);
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
		}
	});

	it("rejects empty name", async () => {
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
		}
	});
});

describe("Templates — cacheMode validation (P10)", () => {
	let root: string;

	beforeEach(() => {
		root = makeTempRoot();
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("throws E_INKER_INVALID_PATH for an unknown cacheMode string", () => {
		try {
			new Templates({
				root,
				cacheMode: bypassTypeCheck<"auto" | "mtime" | "never">("MTIME"),
			});
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
		}
	});
});

describe("Templates — non-ENOENT FS errors wrapped (P9)", () => {
	let root: string;

	beforeEach(() => {
		root = makeTempRoot();
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("EISDIR (template path is a directory) wraps as E_INKER_INVALID_PATH", async () => {
		// Create a directory named foo.inker — readFile will fail with EISDIR.
		// EISDIR / EACCES / ELOOP / ENOTDIR all signal "path exists but is not
		// a readable regular file" — path-axis error, distinct from
		// E_INKER_TEMPLATE_NOT_FOUND (= ENOENT).
		fs.mkdirSync(path.join(root, "foo.inker"));
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("foo", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(InkerRenderError);
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_INVALID_PATH");
			// The original Node error is preserved on .cause for diagnostics.
			expect(err.cause).toBeInstanceOf(Error);
		}
	});
});
