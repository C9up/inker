/**
 * `compile()` / `compileRaw()` — parse without rendering.
 *
 * The syntax check a linter needs. Rendering is not an option for that: it
 * needs data and it runs the template's expressions.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InkerRenderError, Templates } from "../../src/index.js";

const root = mkdtempSync(join(tmpdir(), "inker-compile-"));
writeFileSync(join(root, "good.inker"), "<p>{{ name }}</p>");
writeFileSync(join(root, "bad.inker"), "@if(x)\n<p>never closed</p>");

afterAll(() => rmSync(root, { recursive: true, force: true }));

function templates(): Templates {
	return new Templates({ root });
}

describe("inker > compile", () => {
	it("accepts a template that parses, without rendering it", () => {
		// No data is passed, and `{{ name }}` would be unknown at render time —
		// compile must not care.
		expect(() => templates().compile("good")).not.toThrow();
	});

	it("throws a located InkerRenderError on a syntax error", () => {
		try {
			templates().compile("bad");
			expect.unreachable("compile should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InkerRenderError);
			const e = err as InkerRenderError;
			expect(e.code).toMatch(/^E_INKER_/);
			expect(typeof e.context.line).toBe("number");
		}
	});

	it("reports a template that does not exist", () => {
		expect(() => templates().compile("missing")).toThrow();
	});
});

describe("inker > compileRaw", () => {
	it("accepts a valid source string", () => {
		expect(() => templates().compileRaw("<p>{{ name }}</p>")).not.toThrow();
	});

	it("throws on an invalid source string", () => {
		expect(() => templates().compileRaw("@if(x)\n<p>oops</p>")).toThrow(
			InkerRenderError,
		);
	});

	it("labels the error with the given template name", () => {
		try {
			templates().compileRaw("@if(x)", "inbox/row");
			expect.unreachable("compileRaw should have thrown");
		} catch (err) {
			expect((err as InkerRenderError).context.templateName).toBe("inbox/row");
		}
	});

	it("tolerates a leading BOM, as renderString does", () => {
		expect(() => templates().compileRaw("﻿<p>ok</p>")).not.toThrow();
	});
});
