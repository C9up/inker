import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type HelperFn,
	type InkerRenderError,
	SafeString,
} from "../../src/index.js";
import { Templates } from "../../src/Templates.js";
import { asTyped, bypassTypeCheck } from "../__helpers__/bypass-type-check.js";

function makeTempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "inker-helpers-"));
}

describe("Templates — helpers option (constructor)", () => {
	let root: string;
	beforeEach(() => {
		root = makeTempRoot();
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("accepts a Map of helpers and snapshots the name set", async () => {
		const helpers = new Map<string, HelperFn>([
			["t", (key) => `T:${String(key)}`],
		]);
		const tpl = new Templates({ root, helpers });
		fs.writeFileSync(path.join(root, "hello.inker"), "{{ t('greeting') }}");
		expect(await tpl.render("hello", {})).toBe("T:greeting");
	});

	it("rejects helper names with invalid identifier shape", () => {
		const helpers = new Map<string, HelperFn>([["1bad", () => "x"]]);
		expect(() => new Templates({ root, helpers })).toThrow(
			/E_INKER_INVALID_PATH|not a valid identifier|1bad/,
		);
	});

	it("rejects helper names that are reserved words", () => {
		const helpers = new Map<string, HelperFn>([["if", () => "x"]]);
		try {
			new Templates({ root, helpers });
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
			expect(asTyped<InkerRenderError>(e).message).toContain("reserved word");
		}
	});

	it("rejects helper names that are prototype-pollution keys", () => {
		const helpers = new Map<string, HelperFn>([["__proto__", () => "x"]]);
		try {
			new Templates({ root, helpers });
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
			expect(asTyped<InkerRenderError>(e).message).toContain(
				"prototype-pollution",
			);
		}
	});

	it("freezes the helper name set at construction (D3)", async () => {
		const helpers = new Map<string, HelperFn>([["t", () => "frozen"]]);
		const tpl = new Templates({ root, helpers });
		// Mutating the caller's Map post-construction must NOT register the
		// new name at parse time.
		helpers.set("bogus", () => "should-not-be-seen");
		fs.writeFileSync(path.join(root, "x.inker"), "{{ bogus() }}");
		try {
			await tpl.render("x", {});
			expect.fail("should have thrown — bogus() not in frozen name set");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_UNKNOWN_HELPER");
		}
	});

	it("resolves helper implementation LIVE per call (D4)", async () => {
		const helpers = new Map<string, HelperFn>([["t", () => "v1"]]);
		const tpl = new Templates({ root, helpers });
		fs.writeFileSync(path.join(root, "x.inker"), "{{ t() }}");
		expect(await tpl.render("x", {})).toBe("v1");
		helpers.set("t", () => "v2");
		expect(await tpl.render("x", {})).toBe("v2");
	});

	it("without helpers option, any {{ name(…) }} throws at parse time", async () => {
		const tpl = new Templates({ root });
		fs.writeFileSync(path.join(root, "x.inker"), "{{ foo() }}");
		try {
			await tpl.render("x", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_UNKNOWN_HELPER");
			expect(asTyped<InkerRenderError>(e).message).toContain(
				"no helpers are registered",
			);
		}
	});

	it("renderString validates helper names at parse time too", () => {
		const helpers = new Map<string, HelperFn>([["t", () => "T"]]);
		const tpl = new Templates({ root, helpers });
		expect(tpl.renderString("{{ t() }}", {})).toBe("T");
		try {
			tpl.renderString("{{ bogus() }}", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_UNKNOWN_HELPER");
		}
	});

	it("renderString emits raw SafeString helper return values", () => {
		const helpers = new Map<string, HelperFn>([
			["csrfField", () => new SafeString('<input type="hidden">')],
		]);
		const tpl = new Templates({ root, helpers });
		expect(tpl.renderString("{{ csrfField() }}", {})).toBe(
			'<input type="hidden">',
		);
	});

	it("rejects helpers passed as plain object (P12)", () => {
		const fakeMap = bypassTypeCheck<ReadonlyMap<string, HelperFn>>({
			t: () => "x",
		});
		try {
			new Templates({ root, helpers: fakeMap });
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
			expect(asTyped<InkerRenderError>(e).message).toContain("must be a Map");
		}
	});

	it("rejects non-function helper value (P13)", () => {
		const helpers = new Map<string, HelperFn>([
			["t", bypassTypeCheck<HelperFn>("not a function")],
		]);
		try {
			new Templates({ root, helpers });
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
			expect(asTyped<InkerRenderError>(e).message).toContain(
				"must be a function",
			);
		}
	});

	it("rejects template name with backslash (P16 — Windows-axis alignment)", async () => {
		const tpl = new Templates({ root });
		try {
			await tpl.render("subdir\\evil", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
			expect(asTyped<InkerRenderError>(e).message).toContain("backslash");
		}
	});
});
