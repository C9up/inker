/**
 * The `auto` cache mode reads the environment, and has to read the spelling
 * people actually use.
 *
 * `auto` means "never re-read a template in production, watch mtimes
 * everywhere else". With `NODE_ENV=prod` read verbatim it answered "not
 * production": every render stats the file, and a template edited in place on
 * a live box is picked up — which is exactly what `never` exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inProduction, normalizeNodeEnv } from "../../src/nodeEnv.js";

describe("inker > NODE_ENV aliases", () => {
	let previous: string | undefined;

	beforeEach(() => {
		previous = process.env.NODE_ENV;
	});

	afterEach(() => {
		if (previous === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previous;
	});

	it("counts every production spelling as production", () => {
		for (const value of ["prod", "production", "PROD", "Production"]) {
			process.env.NODE_ENV = value;
			expect(inProduction(), value).toBe(true);
		}
	});

	it("counts nothing else as production", () => {
		for (const value of ["dev", "development", "test", "testing", "staging"]) {
			process.env.NODE_ENV = value;
			expect(inProduction(), value).toBe(false);
		}
	});

	it("counts an absent environment as unknown, not production", () => {
		delete process.env.NODE_ENV;

		expect(normalizeNodeEnv(process.env.NODE_ENV)).toBe("unknown");
		expect(inProduction()).toBe(false);
	});

	it("leaves an unrecognised environment as itself", () => {
		expect(normalizeNodeEnv("staging")).toBe("staging");
		expect(normalizeNodeEnv("QA")).toBe("qa");
	});
});
