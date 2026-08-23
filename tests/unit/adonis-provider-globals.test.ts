/**
 * The globals `@adonisjs/core`'s edge provider shares with every template.
 * A migrated Adonis template writes `{{ config('app.name') }}`,
 * `@each(r in routes())` or `{{ app.env }}` unchanged, so these must exist
 * under the same names and the same SHAPES — `app` and `qs` are objects there,
 * not callables.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import {
	buildCanonicalGlobals,
	buildCanonicalHelpers,
} from "../../src/InkerProvider.js";
import type { InkerHttpContext } from "../../src/InkerRenderer.js";

const rosetta = { t: (k: string) => k };
const router = {
	urlFor: (n: string) => `/${n}`,
	makeUrl: (n: string) => `/${n}`,
	makeSignedUrl: (n: string) => `/${n}?sig=x`,
	namedManifest: () => ({ home: { pattern: "/" } }),
	findOrFail: (n: string) => ({ methods: n === "del" ? ["DELETE"] : ["POST"] }),
};

function helpers(config?: { get(k: string, d?: unknown): unknown }) {
	return buildCanonicalHelpers(
		new AsyncLocalStorage<InkerHttpContext>(),
		rosetta,
		router,
		undefined,
		config,
	);
}

const call = (name: string, ...args: unknown[]): unknown => {
	const fn = helpers({ get: (k, d) => (k === "app.name" ? "Ream" : d) }).get(
		name,
	);
	if (typeof fn !== "function") throw new Error(`${name} is not registered`);
	return fn(...args);
};

describe("inker > the globals Adonis's edge provider shares", () => {
	it("config(key, default) reads the app config", () => {
		expect(call("config", "app.name")).toBe("Ream");
		expect(call("config", "missing.key", "fallback")).toBe("fallback");
	});

	it("config.has() hangs off the same callable, as in Adonis", () => {
		const cfg = helpers({ get: (k) => (k === "a" ? 1 : undefined) }).get(
			"config",
		);
		expect(Reflect.get(Object(cfg), "has")).toBeTypeOf("function");
	});

	it("config degrades to the caller's default with no config service", () => {
		const fn = helpers().get("config");
		if (typeof fn !== "function") throw new Error("not registered");
		expect(fn("anything", "d")).toBe("d");
	});

	it("routes() and routesJSON() expose the named routes", () => {
		expect(call("routes")).toEqual({ home: { pattern: "/" } });
		expect(call("routesJSON")).toBe('{"home":{"pattern":"/"}}');
	});

	it("formAttributes returns the action and the method", () => {
		expect(call("formAttributes", "home")).toEqual({
			action: "/home",
			method: "POST",
		});
	});

	it("formAttributes spoofs a verb a form cannot submit", () => {
		const attrs = Object(call("formAttributes", "del"));
		expect(Reflect.get(attrs, "method")).toBe("POST");
		// DELETE travels as POST carrying `_method`, which the router reads.
		expect(String(Reflect.get(attrs, "action"))).toContain("del");
	});

	it("app and qs are OBJECT globals, not callables", () => {
		const globals = buildCanonicalGlobals({ env: "test" });
		expect(globals.get("app")).toEqual({ env: "test" });
		const qs = Object(globals.get("qs"));
		expect(Reflect.get(qs, "parse")).toBeTypeOf("function");
	});

	it("qs round-trips a flat query string", () => {
		const qs = Object(buildCanonicalGlobals().get("qs"));
		const parse = Reflect.get(qs, "parse");
		const stringify = Reflect.get(qs, "stringify");
		expect(parse("?a=1&b=x")).toEqual({ a: "1", b: "x" });
		expect(stringify({ a: 1, b: "x" })).toBe("a=1&b=x");
	});
});
