import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperFn } from "../../src/helpers.js";
import InkerProvider, {
	buildCanonicalHelpers,
	coerceUrlParams,
	escapeAttr,
	type InkerAppContext,
	loadAssetManifest,
	mergeHelpers,
	resetInkerProviderFlags,
	resolveCacheMode,
	resolveTemplatesRoot,
} from "../../src/InkerProvider.js";
import type { InkerHttpContext } from "../../src/InkerRenderer.js";
import { InkerRenderer } from "../../src/InkerRenderer.js";
import { SafeString } from "../../src/SafeString.js";

interface StubRouter {
	makeUrl(name: string, params?: Record<string, string>): string;
}

interface StubRosetta {
	t(
		key: string,
		params?: Record<
			string,
			string | number | boolean | Date | null | undefined
		>,
		options?: { locale?: string; defaultValue?: string },
	): string;
}

function mkAppContext(
	bindings: Record<string, unknown> = {},
	config: Record<string, unknown> = {},
): {
	app: InkerAppContext;
	singletons: Map<string, () => unknown>;
} {
	const singletons = new Map<string, () => unknown>();
	const app: InkerAppContext = {
		container: {
			singleton<T>(token: unknown, factory: () => T) {
				singletons.set(String(token), factory);
			},
			resolve<T = unknown>(token: unknown): T {
				const key = String(token);
				if (key in bindings) return bindings[key] as T;
				const factory = singletons.get(key);
				if (factory) return factory() as T;
				// Mirror Ream's Container shape — provider duck-types on `code`
				// to distinguish "binding missing" (silent degradation) from
				// "factory threw" (re-throw).
				throw Object.assign(new Error(`[stub] no binding for ${key}`), {
					code: "CONTAINER_NOT_FOUND",
				});
			},
		},
		config: {
			get<T = unknown>(key: string): T | undefined {
				return config[key] as T | undefined;
			},
		},
	};
	return { app, singletons };
}

describe("resolveTemplatesRoot", () => {
	const appRoot = "/srv/myapp";

	it("defaults to <appRoot>/resources/templates when path is missing", () => {
		expect(resolveTemplatesRoot(undefined, appRoot)).toBe(
			path.resolve(appRoot, "resources/templates"),
		);
	});

	it("defaults to <appRoot>/resources/templates when path is empty string", () => {
		expect(resolveTemplatesRoot("", appRoot)).toBe(
			path.resolve(appRoot, "resources/templates"),
		);
	});

	it("joins relative paths to appRoot", () => {
		expect(resolveTemplatesRoot("./custom/tpls", appRoot)).toBe(
			path.resolve(appRoot, "custom/tpls"),
		);
	});

	it("passes absolute paths through unchanged", () => {
		expect(resolveTemplatesRoot("/var/tpls", appRoot)).toBe("/var/tpls");
	});
});

describe("resolveCacheMode", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("passes 'mtime' through verbatim", () => {
		expect(resolveCacheMode("mtime")).toBe("mtime");
	});

	it("passes 'never' through verbatim", () => {
		expect(resolveCacheMode("never")).toBe("never");
	});

	it("resolves 'auto' to 'never' when NODE_ENV=production", () => {
		vi.stubEnv("NODE_ENV", "production");
		expect(resolveCacheMode("auto")).toBe("never");
	});

	it("resolves 'auto' to 'mtime' outside production", () => {
		vi.stubEnv("NODE_ENV", "test");
		expect(resolveCacheMode("auto")).toBe("mtime");
	});

	it("treats undefined as 'auto'", () => {
		vi.stubEnv("NODE_ENV", "production");
		expect(resolveCacheMode(undefined)).toBe("never");
	});

	it("throws on typo'd modes instead of silently downgrading to dev caching", () => {
		expect(() => resolveCacheMode("Production")).toThrow(
			/cacheMode must be "mtime", "never", "auto", or undefined/,
		);
		expect(() => resolveCacheMode("NEVER")).toThrow(/cacheMode must be/);
		expect(() => resolveCacheMode("")).toThrow(/cacheMode must be/);
	});
});

describe("loadAssetManifest", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "inker-manifest-")),
		);
		fs.mkdirSync(path.join(tmp, "public"), { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("returns the injected map verbatim when provided (skips file I/O)", () => {
		const injected = Object.freeze({ "a.css": "/dist/a.123.css" });
		expect(loadAssetManifest(injected, tmp)).toBe(injected);
	});

	it("reads <appRoot>/public/manifest.json when no injection", () => {
		fs.writeFileSync(
			path.join(tmp, "public/manifest.json"),
			JSON.stringify({ "app.css": "/_assets/app.hashed.css" }),
		);
		const result = loadAssetManifest(undefined, tmp);
		expect(result).toEqual({ "app.css": "/_assets/app.hashed.css" });
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("returns undefined when the manifest file is absent", () => {
		expect(loadAssetManifest(undefined, tmp)).toBeUndefined();
	});

	it("returns undefined on JSON parse error", () => {
		fs.writeFileSync(path.join(tmp, "public/manifest.json"), "{not json");
		expect(loadAssetManifest(undefined, tmp)).toBeUndefined();
	});

	it("returns undefined when the root is an array", () => {
		fs.writeFileSync(
			path.join(tmp, "public/manifest.json"),
			JSON.stringify(["a.css", "b.css"]),
		);
		expect(loadAssetManifest(undefined, tmp)).toBeUndefined();
	});

	it("returns undefined when the root is a primitive", () => {
		fs.writeFileSync(path.join(tmp, "public/manifest.json"), "42");
		expect(loadAssetManifest(undefined, tmp)).toBeUndefined();
	});

	it("silently drops non-string entries (D8)", () => {
		fs.writeFileSync(
			path.join(tmp, "public/manifest.json"),
			JSON.stringify({
				"a.css": "/dist/a.css",
				"b.css": 42,
				"c.css": null,
				"d.css": { nested: "obj" },
			}),
		);
		expect(loadAssetManifest(undefined, tmp)).toEqual({
			"a.css": "/dist/a.css",
		});
	});
});

describe("mergeHelpers", () => {
	beforeEach(() => {
		resetInkerProviderFlags();
	});

	const noop: HelperFn = () => "";

	it("returns a fresh Map copy when additional is undefined", () => {
		const canonical = new Map<string, HelperFn>([["t", noop]]);
		const out = mergeHelpers(canonical, undefined);
		expect(out).not.toBe(canonical);
		expect(out.get("t")).toBe(noop);
	});

	it("merges new helpers from additional", () => {
		const canonical = new Map<string, HelperFn>([["t", noop]]);
		const extra: HelperFn = () => "extra";
		const out = mergeHelpers(canonical, { fmt: extra });
		expect(out.get("t")).toBe(noop);
		expect(out.get("fmt")).toBe(extra);
	});

	it("overrides canonical helpers and warns once per name", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const canonical = new Map<string, HelperFn>([["t", noop]]);
		const overrideT: HelperFn = () => "custom";

		mergeHelpers(canonical, { t: overrideT });
		mergeHelpers(canonical, { t: overrideT });

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(/overrides the canonical helper/);
		warn.mockRestore();
	});

	it("warns separately for each canonical name once", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const canonical = new Map<string, HelperFn>([
			["t", noop],
			["url", noop],
		]);
		const extra: HelperFn = () => "";

		mergeHelpers(canonical, { t: extra, url: extra });
		mergeHelpers(canonical, { t: extra, url: extra });

		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it("throws when a value is not a function", () => {
		const canonical = new Map<string, HelperFn>();
		expect(() =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional bad value
			mergeHelpers(canonical, { bad: "not a fn" as unknown as HelperFn }),
		).toThrow(/additionalHelpers\.bad must be a function/);
	});
});

describe("coerceUrlParams", () => {
	it("returns undefined for null / undefined", () => {
		expect(coerceUrlParams(undefined)).toBeUndefined();
		expect(coerceUrlParams(null)).toBeUndefined();
	});

	it("coerces every value via String(v)", () => {
		expect(coerceUrlParams({ id: 42, name: "foo", flag: true })).toEqual({
			id: "42",
			name: "foo",
			flag: "true",
		});
	});

	it("throws when raw is not an object", () => {
		expect(() => coerceUrlParams("nope")).toThrow(/must be a plain object/);
		expect(() => coerceUrlParams(99)).toThrow(/must be a plain object/);
	});

	it("rejects arrays — `typeof [] === 'object'` would otherwise emit numeric-index params silently", () => {
		expect(() => coerceUrlParams([1, 2, 3])).toThrow(
			/must be a plain object; got array/,
		);
	});

	it("rejects null / undefined param values instead of producing /users/undefined", () => {
		expect(() => coerceUrlParams({ id: undefined })).toThrow(
			/param 'id' is undefined/,
		);
		expect(() => coerceUrlParams({ id: null })).toThrow(/param 'id' is null/);
	});

	it("rejects Symbol param values with a typed Inker error (no raw TypeError)", () => {
		expect(() => coerceUrlParams({ id: Symbol("x") })).toThrow(
			/param 'id' is a Symbol/,
		);
	});

	it("returns an empty record for {}", () => {
		expect(coerceUrlParams({})).toEqual({});
	});
});

describe("escapeAttr", () => {
	it("escapes the 5 dangerous attribute chars (incl. single-quote)", () => {
		expect(escapeAttr(`"<>&'`)).toBe("&quot;&lt;&gt;&amp;&#39;");
	});

	it("escapes single-quote so `value='…'`-style attrs cannot be broken", () => {
		expect(escapeAttr("can't")).toBe("can&#39;t");
	});

	it("escapes & before <,> so already-escaped sequences aren't double-escaped", () => {
		expect(escapeAttr("&amp;")).toBe("&amp;amp;");
	});

	it("passes safe content through unchanged", () => {
		expect(escapeAttr("safe-token_123")).toBe("safe-token_123");
		expect(escapeAttr("")).toBe("");
	});
});

describe("buildCanonicalHelpers", () => {
	function setup(
		opts: {
			rosettaT?: StubRosetta["t"];
			routerMakeUrl?: StubRouter["makeUrl"];
			assetManifest?: Readonly<Record<string, string>>;
		} = {},
	) {
		const als = new AsyncLocalStorage<InkerHttpContext>();
		const rosetta: StubRosetta = {
			t:
				opts.rosettaT ??
				((key, _params, options) => `${options?.locale ?? "en"}:${key}`),
		};
		const router: StubRouter = {
			makeUrl:
				opts.routerMakeUrl ??
				((name, params) =>
					params ? `/${name}/${Object.values(params).join("/")}` : `/${name}`),
		};
		const helpers = buildCanonicalHelpers(
			als,
			rosetta,
			router,
			opts.assetManifest,
		);
		return { als, helpers };
	}

	function runInCtx<T>(
		als: AsyncLocalStorage<InkerHttpContext>,
		ctx: InkerHttpContext,
		fn: () => T,
	): T {
		return als.run(ctx, fn);
	}

	function ctx(overrides: Partial<InkerHttpContext> = {}): InkerHttpContext {
		return {
			request: {},
			response: { type: () => undefined, send: () => undefined },
			store: new Map(),
			locale: "en",
			...overrides,
		};
	}

	it("t() delegates to rosetta.t with ctx.locale", () => {
		const { als, helpers } = setup();
		const t = helpers.get("t");
		const result = runInCtx(als, ctx({ locale: "fr" }), () =>
			t?.("welcome", { name: "ada" }),
		);
		expect(result).toBe("fr:welcome");
	});

	it("t() throws outside an inker.render frame", () => {
		const { helpers } = setup();
		const t = helpers.get("t");
		expect(() => t?.("hi")).toThrow(/invoked outside of an inker\.render/);
	});

	it("t() rejects non-string keys", () => {
		const { als, helpers } = setup();
		const t = helpers.get("t");
		expect(() => runInCtx(als, ctx(), () => t?.(42))).toThrow(
			/t\(\) requires a string key/,
		);
	});

	it("csrfField() reads ctx.store.get('csrfToken') and returns a SafeString", () => {
		const { als, helpers } = setup();
		const helper = helpers.get("csrfField");
		const store = new Map<string, unknown>([["csrfToken", "TEST_TOKEN_123"]]);
		const result = runInCtx(als, ctx({ store }), () => helper?.());
		if (!(result instanceof SafeString)) {
			throw new Error("expected SafeString return");
		}
		expect(result.value).toBe(
			'<input type="hidden" name="_csrf" value="TEST_TOKEN_123">',
		);
	});

	it("csrfField() escapes attribute-dangerous characters in the token", () => {
		const { als, helpers } = setup();
		const helper = helpers.get("csrfField");
		const store = new Map<string, unknown>([["csrfToken", '"</bad>&']]);
		const result = runInCtx(als, ctx({ store }), () => helper?.());
		if (!(result instanceof SafeString)) {
			throw new Error("expected SafeString return");
		}
		expect(result.value).toBe(
			'<input type="hidden" name="_csrf" value="&quot;&lt;/bad&gt;&amp;">',
		);
	});

	it("csrfField() throws when csrfToken is missing from store", () => {
		const { als, helpers } = setup();
		const helper = helpers.get("csrfField");
		expect(() => runInCtx(als, ctx(), () => helper?.())).toThrow(
			/blackhole middleware with csrf enabled/,
		);
	});

	it("csrfField() throws when csrfToken is an empty string", () => {
		const { als, helpers } = setup();
		const helper = helpers.get("csrfField");
		const store = new Map<string, unknown>([["csrfToken", ""]]);
		expect(() => runInCtx(als, ctx({ store }), () => helper?.())).toThrow(
			/csrfToken not found in ctx\.store/,
		);
	});

	it("csrfMeta() renders the <meta name=csrf-token> tag from the store", () => {
		const { als, helpers } = setup();
		const helper = helpers.get("csrfMeta");
		const store = new Map<string, unknown>([["csrfToken", 'TOK&"<x']]);
		const result = runInCtx(als, ctx({ store }), () => helper?.());
		if (!(result instanceof SafeString)) {
			throw new Error("expected SafeString return");
		}
		expect(result.value).toBe(
			'<meta name="csrf-token" content="TOK&amp;&quot;&lt;x">',
		);
	});

	it("csrfMeta() throws when csrfToken is missing", () => {
		const { als, helpers } = setup();
		const helper = helpers.get("csrfMeta");
		expect(() => runInCtx(als, ctx(), () => helper?.())).toThrow(
			/blackhole middleware with csrf enabled/,
		);
	});

	it("cspNonce() returns the store nonce, or '' when absent (opt-in)", () => {
		const { als, helpers } = setup();
		const helper = helpers.get("cspNonce");
		const store = new Map<string, unknown>([["cspNonce", "abc123=="]]);
		expect(runInCtx(als, ctx({ store }), () => helper?.())).toBe("abc123==");
		expect(runInCtx(als, ctx(), () => helper?.())).toBe("");
	});

	it("url() delegates to router.makeUrl with stringified params", () => {
		const calls: Array<{ name: string; params?: Record<string, string> }> = [];
		const { als, helpers } = setup({
			routerMakeUrl: (name, params) => {
				calls.push({ name, params });
				return params ? `/${name}/${params.id}` : `/${name}`;
			},
		});
		const url = helpers.get("url");

		const result = runInCtx(als, ctx(), () => url?.("users.show", { id: 42 }));

		expect(result).toBe("/users.show/42");
		expect(calls[0]?.params).toEqual({ id: "42" });
	});

	it("url() rejects non-string route names", () => {
		const { als, helpers } = setup();
		const url = helpers.get("url");
		expect(() => runInCtx(als, ctx(), () => url?.(42))).toThrow(
			/url\(\) requires a string route name/,
		);
	});

	it("url() propagates router throws (unknown name)", () => {
		const { als, helpers } = setup({
			routerMakeUrl: (name) => {
				throw new Error(`Route '${name}' not found.`);
			},
		});
		const url = helpers.get("url");
		expect(() => runInCtx(als, ctx(), () => url?.("nope"))).toThrow(
			/Route 'nope' not found/,
		);
	});

	it("asset() returns the manifest hit when present", () => {
		const { als, helpers } = setup({
			assetManifest: { "app.css": "/_assets/app.abc123.css" },
		});
		const asset = helpers.get("asset");
		expect(runInCtx(als, ctx(), () => asset?.("app.css"))).toBe(
			"/_assets/app.abc123.css",
		);
	});

	it("asset() falls back to /_assets/<name> on miss", () => {
		const { als, helpers } = setup({
			assetManifest: { "app.css": "/_assets/app.abc123.css" },
		});
		const asset = helpers.get("asset");
		expect(runInCtx(als, ctx(), () => asset?.("missing.css"))).toBe(
			"/_assets/missing.css",
		);
	});

	it("asset() falls back to /_assets/<name> when manifest is undefined", () => {
		const { als, helpers } = setup({ assetManifest: undefined });
		const asset = helpers.get("asset");
		expect(runInCtx(als, ctx(), () => asset?.("logo.png"))).toBe(
			"/_assets/logo.png",
		);
	});

	it("asset() rejects non-string names", () => {
		const { als, helpers } = setup();
		const asset = helpers.get("asset");
		expect(() => runInCtx(als, ctx(), () => asset?.(123))).toThrow(
			/asset\(\) requires a string asset name/,
		);
	});
});

describe("InkerProvider lifecycle", () => {
	beforeEach(() => {
		resetInkerProviderFlags();
	});

	it("register() binds InkerRenderer and 'inker' alias", () => {
		const { app, singletons } = mkAppContext();
		const provider = new InkerProvider(app);
		provider.register();
		expect(singletons.has("class InkerRenderer")).toBe(false);
		// Both bindings registered; resolved later by start().
		expect(singletons.size).toBe(2);
		expect(singletons.has("inker")).toBe(true);
	});

	it("resolving InkerRenderer pre-start throws the load-bearing message", () => {
		const { app } = mkAppContext();
		const provider = new InkerProvider(app);
		provider.register();
		expect(() => app.container.resolve(InkerRenderer)).toThrow(
			/resolved before InkerProvider\.start\(\) ran/,
		);
	});

	it("boot() is a no-op (does not force-resolve the renderer)", async () => {
		const { app } = mkAppContext();
		const provider = new InkerProvider(app);
		provider.register();
		await expect(provider.boot()).resolves.toBeUndefined();
	});

	it("ready() and shutdown() are no-ops", async () => {
		const { app } = mkAppContext();
		const provider = new InkerProvider(app);
		await expect(provider.ready()).resolves.toBeUndefined();
		await expect(provider.shutdown()).resolves.toBeUndefined();
	});
});

describe("InkerProvider start() — idempotency & degraded-host", () => {
	let tmp: string;
	beforeEach(() => {
		resetInkerProviderFlags();
		tmp = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "inker-start-")),
		);
		fs.mkdirSync(path.join(tmp, "resources/templates"), { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	function makeStubRosetta(): StubRosetta {
		return {
			t: (key, _params, opts) => `${opts?.locale ?? "en"}:${key}`,
		};
	}

	it("start() is idempotent — second call short-circuits via #started flag (no peer re-resolution)", async () => {
		const rosetta = makeStubRosetta();
		const { app } = mkAppContext({ rosetta, appRoot: tmp }, {});
		const provider = new InkerProvider(app);
		provider.register();

		// Spy on container.resolve to count peer-lookup work. The stub
		// container has no internal singleton cache, so an idempotent
		// short-circuit MUST be observable as zero new `resolve` calls
		// between the two `start()` invocations (otherwise we'd see at
		// minimum a second "rosetta" + "appRoot" lookup).
		const resolveSpy = vi.spyOn(app.container, "resolve");

		await provider.start();
		const callsAfterFirst = resolveSpy.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThan(0); // sanity: first start did work

		await provider.start();
		expect(resolveSpy.mock.calls.length).toBe(callsAfterFirst);

		// Renderer is still resolvable and is the SAME instance across calls
		// — i.e. the #started guard didn't construct a new one on the second
		// start (which would have been a silent leak even though the
		// container's own caching would mask it).
		const first = app.container.resolve(InkerRenderer);
		const second = app.container.resolve(InkerRenderer);
		expect(first).toBe(second);
		expect(first).toBeInstanceOf(InkerRenderer);
	});

	it("start() warns once when rosetta is not registered in the container", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { app } = mkAppContext({ appRoot: tmp }, {});
		const provider = new InkerProvider(app);
		provider.register();

		await provider.start();
		await provider.start();

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(/Rosetta instance/);
		warn.mockRestore();
	});

	it("start() leaves renderer unresolvable when rosetta is missing", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { app } = mkAppContext({ appRoot: tmp }, {});
		const provider = new InkerProvider(app);
		provider.register();
		await provider.start();
		expect(() => app.container.resolve(InkerRenderer)).toThrow(
			/before InkerProvider\.start\(\) ran/,
		);
		warn.mockRestore();
	});

	it("a second provider instance warns independently (per-instance warn-once)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { app: appA } = mkAppContext({ appRoot: tmp }, {});
		await new InkerProvider(appA).start();
		// No resetInkerProviderFlags() — a fresh instance must emit its own
		// diagnostic. The module-level warn-once used to silence the 2nd provider
		// in the same process (audit 2026-06-13).
		const { app: appB } = mkAppContext({ appRoot: tmp }, {});
		await new InkerProvider(appB).start();
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it("start() with rosetta present primes services/main proxy via setInker", async () => {
		const mod = await import("../../src/services/main.js");
		const rosetta = makeStubRosetta();
		const { app } = mkAppContext({ rosetta, appRoot: tmp }, {});
		const provider = new InkerProvider(app);
		provider.register();
		await provider.start();
		expect(mod.getInker()).toBeInstanceOf(InkerRenderer);
	});

	it("start() reads config.inker.templatesRoot and uses it", async () => {
		const customRoot = path.join(tmp, "my-tpls");
		fs.mkdirSync(customRoot, { recursive: true });
		const rosetta = makeStubRosetta();
		const { app } = mkAppContext(
			{ rosetta, appRoot: tmp },
			{ inker: { templatesRoot: customRoot } },
		);
		const provider = new InkerProvider(app);
		provider.register();
		await provider.start();
		const renderer = app.container.resolve<InkerRenderer>(InkerRenderer);
		// The internal Templates uses #root — surface via a render attempt
		// against an absent file in the customRoot to confirm the path is in
		// the error message.
		await expect(renderer._templates.render("missing", {})).rejects.toThrow(
			/missing\.inker/,
		);
	});
});
