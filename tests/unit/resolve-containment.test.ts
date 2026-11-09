import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";

// `resolve()` reads a template's source, so it must stop at the templates
// root exactly as `render()` does — through symlinks too.

function setup(): { views: string; secret: string } {
	const base = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-resolve-")),
	);
	const views = path.join(base, "views");
	const secret = path.join(base, "secret");
	fs.mkdirSync(views);
	fs.mkdirSync(secret);
	fs.writeFileSync(path.join(secret, "leak.inker"), "SECRET");
	fs.writeFileSync(path.join(views, "ok.inker"), "fine");
	fs.mkdirSync(path.join(views, "folder.inker"));
	fs.symlinkSync(secret, path.join(views, "linked"));
	fs.symlinkSync(
		path.join(secret, "leak.inker"),
		path.join(views, "direct.inker"),
	);
	return { views, secret };
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

describe("Templates#resolve containment", () => {
	it("refuses a template reached through a symlinked directory", () => {
		const t = new Templates({ root: setup().views });
		expect(codeOf(() => t.resolve("linked/leak"))).toBe("E_INKER_INVALID_PATH");
	});

	it("refuses a symlinked final segment", () => {
		const t = new Templates({ root: setup().views });
		expect(codeOf(() => t.resolve("direct"))).toBe("E_INKER_INVALID_PATH");
	});

	it("reports a directory as an invalid path, not as missing", () => {
		const t = new Templates({ root: setup().views });
		expect(codeOf(() => t.resolve("folder"))).toBe("E_INKER_INVALID_PATH");
	});

	it("still reads a normal file, reports a missing one, and serves memory", () => {
		const t = new Templates({ root: setup().views });
		expect(t.resolve("ok")).toEqual({ template: "fine" });
		expect(codeOf(() => t.resolve("nope"))).toBe("E_INKER_TEMPLATE_NOT_FOUND");
		t.registerTemplate("mem", { template: "from memory" });
		expect(t.resolve("mem")).toEqual({ template: "from memory" });
	});
});
