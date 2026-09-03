/**
 * InkerProvider — Ream provider that wires `@c9up/inker` into a Ream host.
 *
 * `register()` binds an `InkerRenderer` singleton + the `"inker"` alias via
 * factories that throw pre-`start()` (so an accidental preload-time resolve
 * surfaces immediately instead of silently rendering with an unconfigured
 * Templates instance).
 *
 * `start()` resolves the host router from the container (Ream registers it as
 * `'router'`) + the `@c9up/rosetta` translator (declared as
 * `peerDependenciesMeta.optional`), builds the four canonical helper bodies
 * (`t` / `csrfField` / `url` / `asset`) closing over a single
 * `AsyncLocalStorage<InkerHttpContext>`, constructs the `Templates` instance +
 * `InkerRenderer`, and primes `services/main`'s Proxy via `setInker`.
 *
 * Reading the router from the container — not importing
 * `@c9up/ream/services/router` — keeps inker runtime-agnostic: a non-Ream host
 * never registers `'router'`, so Phase 1 silently degrades (warn-once).
 *
 * Mirrors the StationProvider / AuroraProvider shape — duck-typed
 * container / config / app-context interfaces, `loadBearingCast<T>` as the
 * single sanctioned cross-package narrowing site, `#started` idempotency.
 */

import "./augmentations.js";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { HelperFn } from "./helpers.js";
import type { InkerHttpContext } from "./InkerRenderer.js";
import { InkerRenderer } from "./InkerRenderer.js";
import { inProduction } from "./nodeEnv.js";
import { SafeString } from "./SafeString.js";
import { setInker } from "./services/main.js";
import { type CacheMode, Templates } from "./Templates.js";

// ─── Duck-typed host interfaces ──────────────────────────────────

interface InkerContainer {
	singleton<T>(token: unknown, factory: () => T): void;
	// Async (AdonisJS IoC container parity): resolution returns a Promise.
	resolve<T = unknown>(token: unknown): Promise<T>;
	has(token: unknown): boolean;
}

interface InkerConfigStore {
	get<T = unknown>(key: string): T | undefined;
}

export interface InkerAppContext {
	container: InkerContainer;
	config: InkerConfigStore;
}

// ─── Configuration shape (D14) ──────────────────────────────────

export interface InkerProviderConfig {
	/** Absolute path or relative-to-appRoot. Default: <appRoot>/resources/templates. */
	templatesRoot?: string;
	/** "auto" (default) | "mtime" | "never". */
	cacheMode?: CacheMode;
	/** Optional manifest source for asset(). Direct injection beats <appRoot>/public/manifest.json. */
	assetManifest?: Readonly<Record<string, string>>;
	/** App-supplied helpers merged with canonical. Override warns once per name per process. */
	additionalHelpers?: Readonly<Record<string, HelperFn>>;
}

// ─── Peer-module shape duck-types ──────────────────────────────────

interface ReamRouter {
	/** AdonisJS v7 name (`makeUrl` is the deprecated alias). */
	urlFor(name: string, params?: Record<string, string>): string;
	makeUrl(name: string, params?: Record<string, string>): string;
	/** Signed URL (HMAC via APP_KEY). AdonisJS v7 exposes it as `signedUrlFor`. */
	makeSignedUrl(
		name: string,
		params?: Record<string, string>,
		options?: Record<string, unknown>,
	): string;
	/** Named routes as a serialisable map — Adonis exposes this to templates as
	 * `routes()` / `routesJSON()`. Optional: a router without it degrades to an
	 * empty map rather than failing the render. */
	namedManifest?(): Record<string, unknown>;
	/** Look a route up by name — `formAttributes()` needs its methods. */
	findOrFail?(name: string): { methods?: readonly string[] } | undefined;
}

/** Read-only view of the app config, as Adonis exposes it to templates. */
interface ConfigReader {
	get(key: string, defaultValue?: unknown): unknown;
	has?(key: string): boolean;
}

interface RosettaTranslator {
	t(
		key: string,
		params?: Record<
			string,
			string | number | boolean | Date | null | undefined
		>,
		options?: { locale?: string; defaultValue?: string },
	): string;
}

// ─── Module-scoped flags (process-level, not instance-level) ─────────

const overrideWarnEmittedNames = new Set<string>();

/**
 * @internal Reset module-level flags between tests. The peer-missing and
 * cwd-fallback warns are now per-instance (audit 2026-06-13), so they reset
 * automatically with each new provider — this only clears the remaining
 * module-scoped override-warn set.
 */
export function resetInkerProviderFlags(): void {
	overrideWarnEmittedNames.clear();
}

// ─── Provider class ──────────────────────────────────────────────

export default class InkerProvider {
	#renderer: InkerRenderer | undefined;
	#started = false;
	// P17: per-instance override-warn dedup. Was a module-level Set shared
	// across every provider instance in the process — broke test isolation
	// and multi-tenant scenarios where each tenant has its own provider with
	// its own additionalHelpers map.
	readonly #overrideWarnedNames = new Set<string>();
	// Per-instance warn-once flags (audit 2026-06-13, same class as P17): module
	// -level flags meant a second provider in the same process silently skipped
	// its missing-peer / cwd-fallback diagnostic.
	#peerWarnEmitted = false;
	#appRootFallbackWarned = false;

	constructor(protected app: InkerAppContext) {}

	register(): void {
		this.app.container.singleton(InkerRenderer, () =>
			this.#getRendererOrThrow(),
		);
		this.app.container.singleton("inker", () =>
			this.app.container.resolve<InkerRenderer>(InkerRenderer),
		);
	}

	async boot(): Promise<void> {
		// No-op. Peers (Rosetta, Router) are resolved at start() — earlier
		// phases run before Ignitor finishes wiring the router proxy and
		// before RosettaProvider's boot loads catalogs.
	}

	async start(): Promise<void> {
		if (this.#started) return;

		// Phase 1 — resolve the host router + the Rosetta translator from the
		// container. Reading both from the container — not importing
		// `@c9up/ream/services/router` — keeps inker runtime-agnostic: a non-Ream
		// host never registers `'router'`. Either peer missing → warn-once + skip
		// (rendering stays disabled until both are present). The container yields
		// the real Router instance; factory-thrown errors propagate.
		if (!this.app.container.has("router")) {
			this.#warnPeerMissingOnce(
				"No `'router'` registered in the container (host is not Ream, or the router is not wired). Inker rendering is disabled until a Ream router is present.",
			);
			return;
		}
		const router = await this.app.container.resolve<ReamRouter>("router");
		const rosetta = await this.#resolveRosetta();
		if (rosetta === undefined) {
			this.#warnPeerMissingOnce(
				"`@c9up/rosetta` is not registered in the container. Inker rendering is disabled until a Rosetta instance is present.",
			);
			return;
		}

		// Phase 2 — resolve config.
		const config = this.app.config.get<InkerProviderConfig>("inker") ?? {};
		const appRoot = await this.#readAppRoot();
		const templatesRoot = resolveTemplatesRoot(config.templatesRoot, appRoot);
		const cacheMode = resolveCacheMode(config.cacheMode);
		const assetManifest = loadAssetManifest(config.assetManifest, appRoot);

		// Phase 3 — build canonical helpers Map.
		// Not kept on the provider: the only thing that enters a context into
		// it is InkerRenderer, which is handed this same instance below. The
		// field was a second reference nothing could read.
		const als = new AsyncLocalStorage<InkerHttpContext>();
		const canonical = buildCanonicalHelpers(
			als,
			rosetta,
			router,
			assetManifest,
			await this.#resolveOptionalConfig(),
		);

		// Phase 4 — merge additional helpers (override-warn-once per instance).
		const merged = mergeHelpers(
			canonical,
			config.additionalHelpers,
			this.#overrideWarnedNames,
		);

		// Phase 5 — construct Templates + InkerRenderer + bind into proxy.
		const templates = new Templates({
			root: templatesRoot,
			cacheMode,
			helpers: merged,
		});
		// Object globals (Adonis shares these as values, not callables).
		for (const [name, value] of buildCanonicalGlobals(this.app)) {
			templates.global(name, value);
		}
		// `ctx.view` — a renderer per request, seeded with the request, exactly as
		// AdonisJS's edge provider installs it. Without it every migrated
		// controller's `ctx.view.render(...)` breaks. Resolved through the
		// container rather than imported, so inker keeps no runtime dependency
		// on the host framework.
		await this.#installContextView(templates);
		const renderer = new InkerRenderer(templates, als);
		this.#renderer = renderer;
		setInker(renderer);

		this.#started = true;
	}

	async ready(): Promise<void> {}

	async shutdown(): Promise<void> {
		// Intentionally a no-op. `#started` guards `start()` from re-running,
		// so once the provider has booted, subsequent lifecycle calls have
		// nothing to undo here: `Templates` owns its own cache, AsyncLocalStorage
		// has no destroy contract, and the `setInker` singleton intentionally
		// outlives shutdown so late-arriving handlers don't see a torn-down
		// proxy. `Templates.clearCache()` is the operator's tool, not ours.
	}

	#getRendererOrThrow(): InkerRenderer {
		if (this.#renderer === undefined) {
			throw new Error(
				"[inker] InkerRenderer resolved before InkerProvider.start() ran. " +
					"Wait for the boot lifecycle to complete, or call `start()` manually.",
			);
		}
		return this.#renderer;
	}

	#warnPeerMissingOnce(detail: string): void {
		if (this.#peerWarnEmitted) return;
		this.#peerWarnEmitted = true;
		console.warn(`[inker] ${detail} See https://ream.dev/modules/inker.`);
	}

	async #readAppRoot(): Promise<string> {
		try {
			const raw = await this.app.container.resolve<unknown>("appRoot");
			if (raw instanceof URL) return fileURLToPath(raw);
			if (typeof raw === "string") return raw;
		} catch (err) {
			// Only swallow the "no binding" path — re-throw factory errors so
			// host misconfiguration surfaces instead of being masked as a
			// cwd-fallback.
			if (!isContainerNotFound(err)) throw err;
		}
		if (!this.#appRootFallbackWarned) {
			this.#appRootFallbackWarned = true;
			console.warn(
				"[inker] No `appRoot` binding (URL or string) resolved from the container; falling back to process.cwd(). Templates and the asset manifest will be read relative to the process working directory — bind `appRoot` in the host container if that is not what you want.",
			);
		}
		return process.cwd();
	}

	/**
	 * The config service, behind the `config()` template global (Adonis
	 * parity). Optional in the same way Rosetta is: a host without one renders
	 * fine, `config()` just yields the caller's default.
	 */
	/**
	 * Attach `view` to the host's HTTP context class (AdonisJS
	 * `HttpContext.getter('view', …)`). A singleton getter, so the renderer —
	 * and anything `share()`d onto it — lives for the whole request.
	 *
	 * Silently skipped when the host binds no such class: inker renders fine
	 * outside an HTTP server, and a console app has no context to extend.
	 */
	async #installContextView(templates: Templates): Promise<void> {
		let ctxClass: unknown;
		try {
			ctxClass = await this.app.container.resolve<unknown>("HttpContext");
		} catch (err) {
			if (isContainerNotFound(err)) return;
			throw err;
		}
		const getter = Reflect.get(Object(ctxClass), "getter");
		if (typeof getter !== "function") return;
		getter.call(
			ctxClass,
			"view",
			function (this: { request?: unknown }): unknown {
				return templates.createRenderer().share({ request: this.request });
			},
			true,
		);
	}

	async #resolveOptionalConfig(): Promise<ConfigReader | undefined> {
		for (const token of ["config", "Config"]) {
			try {
				const candidate = await this.app.container.resolve<unknown>(token);
				if (
					typeof candidate === "object" &&
					candidate !== null &&
					typeof Reflect.get(candidate, "get") === "function"
				) {
					const reader: ConfigReader = {
						get: (key, def) =>
							Reflect.get(candidate, "get").call(candidate, key, def),
					};
					const has = Reflect.get(candidate, "has");
					if (typeof has === "function") {
						reader.has = (key) => Boolean(has.call(candidate, key));
					}
					return reader;
				}
			} catch (err) {
				if (isContainerNotFound(err)) continue;
				throw err;
			}
		}
		return undefined;
	}

	async #resolveRosetta(): Promise<RosettaTranslator | undefined> {
		// Try container resolution under both the canonical "rosetta" alias
		// and the class binding. RosettaProvider binds both (per
		// `packages/rosetta/src/RosettaProvider.ts`).
		//
		// Only the "binding not registered" path is swallowed (host truly
		// lacks Rosetta — Phase 1 silently degrades). Factory-thrown errors
		// (catalog load failure, malformed YAML, etc.) re-throw — Station's
		// `#resolveDb` is loud for the same reason: surfacing operator
		// misconfiguration beats misdiagnosing it as "rosetta missing".
		const tokens: readonly string[] = ["rosetta", "Rosetta"];
		for (const token of tokens) {
			try {
				const candidate = await this.app.container.resolve<unknown>(token);
				if (isRosettaShape(candidate)) {
					return candidate;
				}
			} catch (err) {
				if (isContainerNotFound(err)) continue;
				throw err;
			}
		}
		return undefined;
	}
}

// ─── Pure resolvers (exported @internal for unit tests) ──────────────

/**
 * Resolve the templates root directory:
 *   - missing / empty → `<appRoot>/resources/templates`
 *   - absolute path → pass through
 *   - relative path → joined to `appRoot`
 */
export function resolveTemplatesRoot(
	userPath: string | undefined,
	appRoot: string,
): string {
	if (typeof userPath !== "string" || userPath.length === 0) {
		return resolvePath(appRoot, "resources/templates");
	}
	return isAbsolute(userPath) ? userPath : resolvePath(appRoot, userPath);
}

/**
 * Resolve the cache mode:
 *   - explicit "mtime" / "never" → pass through
 *   - "auto" / undefined → "never" in production, "mtime" otherwise
 *   - anything else → throw (typo'd modes like `"Production"` or `"NEVER"`
 *     should not silently downgrade to dev caching)
 */
export function resolveCacheMode(
	userMode: CacheMode | string | undefined,
): "mtime" | "never" {
	if (userMode === "mtime" || userMode === "never") return userMode;
	if (userMode !== undefined && userMode !== "auto") {
		throw new Error(
			`[inker] config.inker.cacheMode must be "mtime", "never", "auto", or undefined; got ${JSON.stringify(userMode)}.`,
		);
	}
	return inProduction() ? "never" : "mtime";
}

/**
 * Load the asset manifest:
 *   - injected value wins (returned verbatim — the caller's freezing applies)
 *   - else read `<appRoot>/public/manifest.json` synchronously at boot
 *   - else `undefined`
 *
 * Malformed manifests (non-object root, array, JSON parse error) → `undefined`.
 * Non-string entries inside a valid object are silently dropped (D8).
 */
export function loadAssetManifest(
	injected: Readonly<Record<string, string>> | undefined,
	appRoot: string,
): Readonly<Record<string, string>> | undefined {
	if (injected !== undefined) return injected;
	const manifestPath = resolvePath(appRoot, "public/manifest.json");
	let raw: string;
	try {
		raw = fs.readFileSync(manifestPath, "utf8");
	} catch (err) {
		// P19: ENOENT is "no manifest configured" — silent absence is the
		// expected dev-without-build state. Any OTHER error (EACCES, EISDIR,
		// ELOOP, etc.) indicates a real misconfiguration that would otherwise
		// surface as a silent "every asset URL falls back to /_assets/foo"
		// degradation in prod. Warn so the operator sees the misconfig.
		const code =
			err instanceof Error ? (Reflect.get(err, "code") as unknown) : undefined;
		if (typeof code === "string" && code !== "ENOENT") {
			console.warn(
				`[inker] Failed to read asset manifest at ${manifestPath}: ${code}. asset() helpers will fall back to '/_assets/<path>' until this is resolved.`,
			);
		}
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return undefined;
	}
	const out: Record<string, string> = Object.create(null);
	for (const [k, v] of Object.entries(parsed)) {
		if (typeof v === "string") out[k] = v;
	}
	return Object.freeze(out);
}

/**
 * Merge canonical + app-supplied helpers into one Map. Override warns once
 * per name per process. Function-type validation is local; helper-key
 * validation (identifier shape / reserved words / prototype-pollution
 * denylists) is delegated to the `Templates` constructor (53.4 AC1).
 */
export function mergeHelpers(
	canonical: ReadonlyMap<string, HelperFn>,
	additional: Readonly<Record<string, HelperFn>> | undefined,
	// P17: optional per-instance warn-dedup set. Defaults to the module-level
	// set for backward compat with direct callers; InkerProvider now passes
	// its own per-instance `#overrideWarnedNames` so multi-tenant /
	// multi-provider setups don't share warn state. Tests that rely on the
	// module-level set still work via `resetInkerProviderFlags`.
	warnedNames: Set<string> = overrideWarnEmittedNames,
): Map<string, HelperFn> {
	const out = new Map(canonical);
	if (additional === undefined) return out;
	for (const [name, fn] of Object.entries(additional)) {
		if (typeof fn !== "function") {
			throw new Error(
				`[inker] additionalHelpers.${name} must be a function; got ${typeof fn}.`,
			);
		}
		if (out.has(name) && !warnedNames.has(name)) {
			warnedNames.add(name);
			console.warn(
				`[inker] additionalHelpers.${name} overrides the canonical helper. Suppressing further warnings for this name.`,
			);
		}
		out.set(name, fn);
	}
	return out;
}

/**
 * Coerce `url()` params: every value becomes a string via `String(v)`. Nullish
 * roots return `undefined` (no replacement map needed). Non-object roots and
 * arrays throw. Null / undefined / Symbol values throw rather than emit
 * silently-broken URLs like `/users/undefined`.
 */
export function coerceUrlParams(
	raw: unknown,
): Record<string, string> | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(
			`[inker] url() params must be a plain object; got ${Array.isArray(raw) ? "array" : typeof raw}.`,
		);
	}
	// P9: Date objects pass the "is object, not array" check but `Object.entries`
	// returns `[]` for them — silently emitting an empty params Map and a URL
	// built from no replacements. Refuse explicitly with a hint pointing to
	// `toISOString()`.
	if (raw instanceof Date) {
		throw new Error(
			"[inker] url() params cannot be a Date instance — call `.toISOString()` first or wrap it in a plain object.",
		);
	}
	const out: Record<string, string> = Object.create(null);
	for (const [k, v] of Object.entries(raw)) {
		if (v === null || v === undefined) {
			throw new Error(
				`[inker] url() param '${k}' is ${v === null ? "null" : "undefined"} — omit the key or provide a value.`,
			);
		}
		if (typeof v === "symbol") {
			throw new Error(
				`[inker] url() param '${k}' is a Symbol — only stringifiable primitives are supported.`,
			);
		}
		// P8: NaN / +Infinity / -Infinity all stringify into URL-unfriendly
		// `"NaN"` / `"Infinity"` literals, producing routes like
		// `/users/NaN`. Authors usually arrive here via a downstream helper
		// that returned an unexpected non-finite value; surface it loud.
		if (typeof v === "number" && !Number.isFinite(v)) {
			throw new Error(
				`[inker] url() param '${k}' is ${Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity"} — only finite numbers are supported.`,
			);
		}
		out[k] = String(v);
	}
	return out;
}

/**
 * 5-char HTML attribute-value escaper. Distinct from `escapeHtml` (text-node
 * use): attribute values need BOTH `"` and `'` escape so `value="…"` and
 * `value='…'` cannot be broken, while text-nodes don't need quote escapes
 * but do need `&` first to avoid double-escape.
 */
export function escapeAttr(value: string): string {
	// P10: backtick added for parity with `escapeChar` in render.ts. Legacy
	// IE and some permissive parsers treat backtick as an attribute-value
	// delimiter inside unquoted attributes; we still emit quoted attributes
	// but encode it defensively in case a downstream rewrite drops the
	// quotes.
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/`/g, "&#96;");
}

/**
 * The values Adonis shares as OBJECT globals rather than callables — a template
 * writes `{{ app.env }}` and `{{ qs.stringify(o) }}`, so wrapping them in a
 * function would break a migrated template.
 */
export function buildCanonicalGlobals(app?: unknown): Map<string, unknown> {
	const globals = new Map<string, unknown>();
	if (app !== undefined) globals.set("app", app);
	// Flat pairs, which is what a template composes. Built on URLSearchParams
	// so there is no dependency to carry.
	globals.set("qs", {
		parse: (input: unknown): Record<string, string> =>
			Object.fromEntries(
				new URLSearchParams(String(input ?? "").replace(/^\?/, "")),
			),
		stringify: (input: unknown): string =>
			isPlainRecord(input)
				? new URLSearchParams(
						Object.entries(input).map(([k, v]): [string, string] => [
							k,
							String(v ?? ""),
						]),
					).toString()
				: "",
	});
	return globals;
}

/**
 * Build the four canonical helper bodies. Each closes over `als` + its
 * resolved peer + the (frozen) asset manifest. Helpers are SYNC — crossing
 * an async boundary would drop the ALS frame (53.4 D2).
 */
export function buildCanonicalHelpers(
	als: AsyncLocalStorage<InkerHttpContext>,
	rosetta: RosettaTranslator,
	router: ReamRouter,
	assetManifest: Readonly<Record<string, string>> | undefined,
	/** The config service behind the `config()` global. `app` is not here: it is
	 * an OBJECT global (see `buildCanonicalGlobals`), not a callable helper. */
	appConfig?: ConfigReader,
): Map<string, HelperFn> {
	const requireCtx = (helperName: string): InkerHttpContext => {
		const ctx = als.getStore();
		if (ctx === undefined) {
			throw new Error(
				`[inker] ${helperName}() invoked outside of an inker.render(ctx, …) call — store unavailable.`,
			);
		}
		return ctx;
	};

	const helpers = new Map<string, HelperFn>();

	helpers.set("t", (...args: readonly unknown[]): string => {
		const [key, params] = args;
		if (typeof key !== "string") {
			throw new Error(`[inker] t() requires a string key; got ${typeof key}.`);
		}
		const ctx = requireCtx("t");
		// Rosetta's TranslationParams is narrower than HelperFn's
		// `unknown[]` — the load-bearing narrow is the contract boundary;
		// Rosetta validates value types and throws on unsupported shapes.
		const rosettaParams =
			params === undefined
				? undefined
				: loadBearingCast<
						Record<string, string | number | boolean | Date | null | undefined>
					>(params);
		return rosetta.t(key, rosettaParams, { locale: ctx.locale });
	});

	// D6 (Shield parity): csrfField/csrfMeta DEGRADE — when there is no token
	// (no request context, or CSRF not enabled), return an empty SafeString
	// instead of throwing, so templates can write `{{ csrfField() }}`
	// unconditionally (no `@if(csrfEnabled)` guard).
	helpers.set("csrfField", (..._args: readonly unknown[]): SafeString => {
		const token = als.getStore()?.store.get("csrfToken");
		if (typeof token !== "string" || token.length === 0) {
			return new SafeString("");
		}
		return new SafeString(
			`<input type="hidden" name="_csrf" value="${escapeAttr(token)}">`,
		);
	});

	helpers.set("csrfMeta", (..._args: readonly unknown[]): SafeString => {
		const token = als.getStore()?.store.get("csrfToken");
		if (typeof token !== "string" || token.length === 0) {
			return new SafeString("");
		}
		return new SafeString(
			`<meta name="csrf-token" content="${escapeAttr(token)}">`,
		);
	});

	helpers.set("cspNonce", (..._args: readonly unknown[]): string => {
		const ctx = requireCtx("cspNonce");
		const nonce = ctx.store.get("cspNonce");
		// Non-throwing: CSP nonces are opt-in (only present when the CSP uses
		// `@nonce`), so an absent nonce yields an empty attribute, not an error.
		return typeof nonce === "string" ? nonce : "";
	});

	// AdonisJS v7 URL builder parity: `urlFor` (v7; `makeUrl` is deprecated) and
	// `signedUrlFor` (HMAC-signed). `url` is kept as a legacy alias of `urlFor`.
	const buildUrl = (label: string, args: readonly unknown[]): string => {
		const [name, params] = args;
		if (typeof name !== "string") {
			throw new Error(
				`[inker] ${label}() requires a string route name; got ${typeof name}.`,
			);
		}
		return router.urlFor(name, coerceUrlParams(params));
	};
	helpers.set("url", (...args: readonly unknown[]): string =>
		buildUrl("url", args),
	);
	helpers.set("urlFor", (...args: readonly unknown[]): string =>
		buildUrl("urlFor", args),
	);
	helpers.set("signedUrlFor", (...args: readonly unknown[]): string => {
		const [name, params, options] = args;
		if (typeof name !== "string") {
			throw new Error(
				`[inker] signedUrlFor() requires a string route name; got ${typeof name}.`,
			);
		}
		const opts = isPlainRecord(options) ? options : undefined;
		return router.makeSignedUrl(name, coerceUrlParams(params), opts);
	});

	// ---- the globals Adonis's edge provider shares, so a migrated template
	// keeps working unchanged (`{{ config('app.name') }}`, `@each(r in routes())`).

	const configReader: HelperFn & { has?: (key: string) => boolean } = (
		...args: readonly unknown[]
	): unknown => {
		const [key, defaultValue] = args;
		if (typeof key !== "string") {
			throw new Error(
				`[inker] config() requires a string key; got ${typeof key}.`,
			);
		}
		return appConfig === undefined
			? defaultValue
			: appConfig.get(key, defaultValue);
	};
	// Adonis hangs `has` off the same callable, so `config.has('x')` works.
	configReader.has = (key: string): boolean =>
		appConfig?.has?.(key) ?? appConfig?.get(key) !== undefined;
	helpers.set("config", configReader);

	const namedRoutes = (): Record<string, unknown> =>
		router.namedManifest?.() ?? {};
	helpers.set("routes", (): unknown => namedRoutes());
	helpers.set("routesJSON", (): string => JSON.stringify(namedRoutes()));

	/**
	 * `{ action, method }` for a form (Adonis `formAttributes`). A verb HTML
	 * cannot submit is sent as POST carrying `_method`, which is the spoofing
	 * ream's router already reads.
	 */
	helpers.set("formAttributes", (...args: readonly unknown[]): unknown => {
		const [name, params, options] = args;
		if (typeof name !== "string") {
			throw new Error(
				`[inker] formAttributes() requires a string route name; got ${typeof name}.`,
			);
		}
		const found = router.findOrFail?.(name);
		let method = (found?.methods?.[0] ?? "GET").toUpperCase();
		const original = method;
		// A form cannot issue HEAD; GET is the equivalent request.
		if (method === "HEAD") method = "GET";
		const opts = isPlainRecord(options) ? { ...options } : {};
		if (method !== "GET" && method !== "POST") {
			method = "POST";
			const qs = isPlainRecord(opts.qs) ? opts.qs : {};
			opts.qs = { _method: original, ...qs };
		}
		return { action: buildUrl("formAttributes", [name, params, opts]), method };
	});

	helpers.set("asset", (...args: readonly unknown[]): string => {
		const [name] = args;
		if (typeof name !== "string") {
			throw new Error(
				`[inker] asset() requires a string asset name; got ${typeof name}.`,
			);
		}
		return assetManifest?.[name] ?? `/_assets/${name}`;
	});

	return helpers;
}

// ─── Internal predicates / casts ──────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRosettaShape(value: unknown): value is RosettaTranslator {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof Reflect.get(value, "t") === "function"
	);
}

/**
 * Ream's container throws a `ReamError` with `code === "E_CONTAINER_NOT_FOUND"`
 * when a token is unbound. Duck-typed here so `@c9up/ream` stays an optional
 * peer (no import-time dep on its error class).
 */
function isContainerNotFound(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	return err.code === "E_CONTAINER_NOT_FOUND";
}

/**
 * SANCTIONED CROSS-PACKAGE NARROWING — the ONE production site in
 * `@c9up/inker/provider` where `as T` is permitted. Memory
 * `feedback_no_any_types` is honoured by funnelling every load-bearing
 * narrow (dynamic peer imports, Rosetta params widened to Inker's HelperFn
 * shape) through this single function. Analogous to 54.2 AC15 / 54.1 AC9 /
 * `tests/__helpers__/bypass-type-check.ts`. Every call site MUST carry a
 * rationale comment explaining why static narrowing isn't expressible at
 * the boundary. NEVER widen this helper beyond `unknown → T`.
 */
function loadBearingCast<T>(value: unknown): T {
	return value as T;
}
