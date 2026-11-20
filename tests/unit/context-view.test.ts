/**
 * `ctx.view` — a renderer per request, the way AdonisJS's edge provider
 * installs it (`HttpContext.getter('view', …)`, singleton). Every migrated
 * controller calls `ctx.view.render(...)`, so its absence broke all of them.
 *
 * inker resolves the context class from the CONTAINER rather than importing the
 * host framework, so this stays agnostic.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InkerProvider, {
	type InkerAppContext,
	resetInkerProviderFlags,
} from "../../src/InkerProvider.js";
import { InkerRenderer } from "../../src/InkerRenderer.js";
import { getInker, setInker } from "../../src/services/main.js";
import { TemplateRenderer, Templates } from "../../src/Templates.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";
import { Macroable } from "../_support/macroable.js";

describe("inker > ctx.view", () => {
	it("hands each context its own renderer, seeded with the request", () => {
		class Ctx extends Macroable {
			request = { url: "/one" };
			// The getter is installed at runtime, so the instance carries keys
			// the class does not declare.
			[key: string]: unknown;
		}
		const templates = new Templates({
			root: process.cwd(),
			cacheMode: "never",
		});
		Ctx.getter(
			"view",
			function (this: { request?: unknown }): unknown {
				return templates.createRenderer().share({ request: this.request });
			},
			true,
		);
		const ctx: Record<string, unknown> = Object.assign(new Ctx());
		const view = ctx.view;
		expect(view).toBeDefined();
		const state = Object(view);
		expect(Reflect.get(state, "renderString")).toBeTypeOf("function");
	});

	it("is a singleton per context, so share() survives the request", () => {
		class Ctx extends Macroable {
			request = {};
			[key: string]: unknown;
		}
		const templates = new Templates({
			root: process.cwd(),
			cacheMode: "never",
		});
		Ctx.getter("view", (): unknown => templates.createRenderer(), true);
		const ctx: Record<string, unknown> = Object.assign(new Ctx());
		expect(ctx.view).toBe(ctx.view);
	});

	it("the renderer reads the shared request", () => {
		const templates = new Templates({
			root: process.cwd(),
			cacheMode: "never",
		});
		const view = templates.createRenderer().share({ request: { url: "/x" } });
		expect(view.renderString("{{ request.url }}")).toBe("/x");
	});
});

/**
 * A request context the way ream builds one: the store the CSRF and CSP
 * middlewares fill, the negotiated locale, and the `view` getter the provider
 * installs.
 */
class RequestCtx extends Macroable {
	readonly request = { url: "/form" };
	readonly response = {
		type: (): undefined => undefined,
		send: (): undefined => undefined,
	};
	readonly store = new Map<string, unknown>();
	locale = "en";
	[key: string]: unknown;
}

function viewOf(ctx: RequestCtx): TemplateRenderer {
	const view: unknown = ctx.view;
	if (!(view instanceof TemplateRenderer)) {
		throw new Error("ctx.view is not a TemplateRenderer");
	}
	return view;
}

function hostApp(
	root: string,
	bindings: Record<string, unknown>,
): InkerAppContext {
	const resolved: Record<string, unknown> = {
		router: {
			makeUrl: () => "/",
			urlFor: () => "/",
			makeSignedUrl: () => "/?signature=stub",
		},
		appRoot: root,
		HttpContext: RequestCtx,
		...bindings,
	};
	const singletons = new Map<string, () => unknown>();
	return {
		container: {
			singleton(token: unknown, factory: () => unknown): void {
				singletons.set(String(token), factory);
			},
			async resolve<T = unknown>(token: unknown): Promise<T> {
				const key = String(token);
				const value = key in resolved ? resolved[key] : singletons.get(key)?.();
				if (value === undefined) {
					throw Object.assign(new Error(`no binding for ${key}`), {
						code: "E_CONTAINER_NOT_FOUND",
					});
				}
				return bypassTypeCheck<T>(value);
			},
			has(token: unknown): boolean {
				const key = String(token);
				return key in resolved || singletons.has(key);
			},
		},
		config: { get: () => undefined },
	};
}

describe("inker > ctx.view inside a booted provider", () => {
	let root: string;
	beforeEach(() => {
		resetInkerProviderFlags();
		setInker(undefined);
		root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "inker-ctx-view-")),
		);
		const templates = path.join(root, "resources", "templates");
		fs.mkdirSync(templates, { recursive: true });
		fs.writeFileSync(
			path.join(templates, "page.inker"),
			"{{ csrfField() }}|{{ cspNonce() }}|{{ t('greeting') }}",
		);
		fs.writeFileSync(path.join(templates, "plain.inker"), "{{ cspNonce() }}");
	});
	afterEach(() => {
		setInker(undefined);
		fs.rmSync(root, { recursive: true, force: true });
	});

	function requestCtx(): RequestCtx {
		const ctx = new RequestCtx();
		ctx.store.set("csrfToken", "TOKEN123");
		ctx.store.set("cspNonce", "NONCE");
		ctx.locale = "fr";
		return ctx;
	}

	async function boot(bindings: Record<string, unknown>): Promise<void> {
		const provider = new InkerProvider(hostApp(root, bindings));
		provider.register();
		await provider.start();
	}

	const rosetta = {
		t: (key: string, _params?: unknown, opts?: { locale?: string }): string =>
			`${opts?.locale ?? "?"}:${key}`,
	};

	it("renders a file with the request's CSRF token, CSP nonce and locale", async () => {
		await boot({ rosetta });
		const ctx = requestCtx();
		expect(await viewOf(ctx).render("page")).toBe(
			'<input type="hidden" name="_csrf" value="TOKEN123">|NONCE|fr:greeting',
		);
	});

	it("renders the same output as inker.renderToString(ctx, …)", async () => {
		await boot({ rosetta });
		const ctx = requestCtx();
		const inker = getInker();
		expect(inker).toBeInstanceOf(InkerRenderer);
		expect(await viewOf(ctx).render("page")).toBe(
			await inker?.renderToString(ctx, "page", {}),
		);
	});

	it("binds the request for every render entry point", async () => {
		await boot({ rosetta });
		const view = viewOf(requestCtx());
		expect(view.renderString("{{ t('k') }}")).toBe("fr:k");
		expect(view.renderSync("page")).toContain("TOKEN123");
		expect(view.renderRawSync("[{{ csrfMeta() }}]")).toBe(
			'[<meta name="csrf-token" content="TOKEN123">]',
		);
		expect(await view.renderRaw("{{ cspNonce() }}")).toBe("NONCE");
		expect(view.clone().renderString("{{ cspNonce() }}")).toBe("NONCE");
	});

	it("keeps two requests apart", async () => {
		await boot({ rosetta });
		const one = requestCtx();
		const two = requestCtx();
		two.store.set("csrfToken", "OTHER");
		const [a, b] = await Promise.all([
			viewOf(one).renderString("{{ csrfField() }}"),
			viewOf(two).renderString("{{ csrfField() }}"),
		]);
		expect(a).toContain("TOKEN123");
		expect(b).toContain("OTHER");
	});

	it("renders without @c9up/rosetta: ctx.view and the inker service come up", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await boot({});
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
		const ctx = requestCtx();
		expect(getInker()).toBeInstanceOf(InkerRenderer);
		expect(viewOf(ctx).renderString("{{ csrfField() }}|{{ cspNonce() }}")).toBe(
			'<input type="hidden" name="_csrf" value="TOKEN123">|NONCE',
		);
		expect(await getInker()?.renderToString(ctx, "plain", {})).toBe("NONCE");
	});

	it("without @c9up/rosetta, inker registers no t() of its own", async () => {
		await boot({});
		expect(() => viewOf(requestCtx()).renderString("{{ t('k') }}")).toThrow(
			/'t' is not a helper, a global or a function/,
		);
	});
});
