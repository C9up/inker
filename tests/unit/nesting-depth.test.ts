import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";
import { nativeBinarySuffix } from "../../src/vendor/nativeBinary.js";

const PKG_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/** The parser's block-nesting cap (`MAX_BLOCK_DEPTH` in parse.rs). */
const MAX_BLOCK_DEPTH = 256;

function nestedIfs(depth: number): string {
	return `${"@if(true)".repeat(depth)}x${"@endif".repeat(depth)}`;
}

function engine(): Templates {
	return new Templates({
		root: fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "inker-depth-")),
		),
	});
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

describe("block nesting depth", () => {
	it("parses hostile nesting in a child process without killing it", () => {
		// The native parser used to overflow its stack and SIGSEGV the whole
		// process. Run it out of process so a regression fails the test rather
		// than the test runner.
		const binary = path.join(PKG_ROOT, `index.${nativeBinarySuffix()}.node`);
		const script = `
			const native = require(${JSON.stringify(binary)});
			const src = "@if(true)".repeat(20000) + "x" + "@endif".repeat(20000);
			try {
				native.parseTemplate(src, [], [], [], "", []);
				console.log("PARSED");
			} catch (e) {
				console.log(JSON.parse(e.message).code);
			}
		`;
		const child = spawnSync(process.execPath, ["-e", script], {
			encoding: "utf8",
		});
		expect(child.signal).toBeNull();
		expect(child.status).toBe(0);
		expect(child.stdout.trim()).toBe("E_INKER_PARSE_ERROR");
	});

	it("rejects 20,000 nested @if with a typed parse error", () => {
		expect(codeOf(() => engine().renderString(nestedIfs(20_000)))).toBe(
			"E_INKER_PARSE_ERROR",
		);
	});

	it("rejects one level past the cap, and renders exactly at the cap", () => {
		const templates = engine();
		expect(
			codeOf(() => templates.renderString(nestedIfs(MAX_BLOCK_DEPTH + 1))),
		).toBe("E_INKER_PARSE_ERROR");
		expect(templates.renderString(nestedIfs(MAX_BLOCK_DEPTH))).toBe("x");
	});

	it("counts an @elseif chain toward the cap", () => {
		const chain = `@if(a)x${"@elseif(b)y".repeat(20_000)}@endif`;
		expect(codeOf(() => engine().renderString(chain))).toBe(
			"E_INKER_PARSE_ERROR",
		);
	});

	it("maps a stack overflow during the render to a typed error", () => {
		// A helper that recurses forever overflows the V8 stack inside the walk.
		const templates = new Templates({
			root: fs.realpathSync.native(
				fs.mkdtempSync(path.join(os.tmpdir(), "inker-depth-")),
			),
			helpers: new Map([["loop", (): unknown => loopForever()]]),
		});
		expect(codeOf(() => templates.renderString("{{ loop() }}"))).toBe(
			"E_INKER_RENDER_DEPTH",
		);
	});
});

function loopForever(): number {
	return loopForever() + 1;
}
