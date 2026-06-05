/**
 * End-to-end integration: boot a minimal Ream host (Container + Router +
 * Rosetta) wired through `InkerProvider`, exercise each canonical helper.
 *
 * The integration test is the ONE place where `@c9up/inker` requires Ream +
 * Rosetta at runtime (devDeps only — they are optional peers). Every other
 * test stays leaf-clean.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetInkerProviderFlags } from "../../src/InkerProvider.js";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { asTyped } from "../__helpers__/bypass-type-check.js";
import {
	type BuiltApp,
	buildMinimalReamApp,
	fixtureRoot,
} from "./__helpers__/buildMinimalReamApp.js";

const HOST_ROOT = fixtureRoot(import.meta.url, "./fixtures/ream-host/");

async function setupApp(
	opts: Partial<Parameters<typeof buildMinimalReamApp>[0]> = {},
): Promise<BuiltApp> {
	return buildMinimalReamApp({ appRoot: HOST_ROOT, ...opts });
}

describe("inker provider — end-to-end with Ream host", () => {
	beforeEach(() => {
		_resetInkerProviderFlags();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders a template using all four canonical helpers", async () => {
		const app = await setupApp({
			inkerConfig: {
				assetManifest: { "app.css": "/_assets/app.abc123.css" },
			},
		});
		app.router.get("/users/:id", () => undefined).as("users.update");
		const ctx = app.makeCtx({
			store: new Map([["csrfToken", "TEST_CSRF"]]),
		});

		await app.inker.render(ctx, "welcome", {
			user: { id: 42, name: "Ada" },
		});

		expect(ctx.typeCalls).toEqual(["text/html; charset=utf-8"]);
		expect(ctx.sendCalls).toHaveLength(1);
		const body = ctx.sendCalls[0] ?? "";
		expect(body).toContain("Hello, Ada!");
		expect(body).toContain('action="/users/42"');
		expect(body).toContain(
			'<input type="hidden" name="_csrf" value="TEST_CSRF">',
		);
		expect(body).toContain('href="/_assets/app.abc123.css"');
	});

	it("t() reads ctx.locale on every render", async () => {
		const app = await setupApp();
		const ctxEn = app.makeCtx({ locale: "en" });
		const ctxFr = app.makeCtx({ locale: "fr" });

		const en = await app.inker.renderToString(ctxEn, "t-only", {
			key: "greeting",
			name: "Ada",
		});
		const fr = await app.inker.renderToString(ctxFr, "t-only", {
			key: "greeting",
			name: "Ada",
		});

		expect(en.trim()).toBe("Hello, Ada!");
		expect(fr.trim()).toBe("Bonjour, Ada !");
	});

	it("csrfField() reads ctx.store.get('csrfToken') verbatim", async () => {
		const app = await setupApp();
		const ctx = app.makeCtx({
			store: new Map([["csrfToken", "FIXED_TOKEN"]]),
		});

		const html = await app.inker.renderToString(ctx, "csrf-only", {});

		expect(html.trim()).toBe(
			'<input type="hidden" name="_csrf" value="FIXED_TOKEN">',
		);
	});

	it("csrfField() missing token throws E_INKER_HELPER_THROW with the Shield-hint cause", async () => {
		const app = await setupApp();
		const ctx = app.makeCtx(); // empty store

		let caught: unknown;
		try {
			await app.inker.renderToString(ctx, "csrf-only", {});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(InkerRenderError);
		const inkerErr = asTyped<InkerRenderError>(caught);
		expect(inkerErr.code).toBe("E_INKER_HELPER_THROW");
		expect(asTyped<Error>(inkerErr.cause).message).toMatch(
			/blackhole middleware with csrf enabled/,
		);
	});

	it("url() interpolates :id from params", async () => {
		const app = await setupApp();
		app.router.get("/users/:id", () => undefined).as("users.show");
		const ctx = app.makeCtx();

		const out = await app.inker.renderToString(ctx, "url-only", {
			route: "users.show",
			id: 42,
		});

		expect(out.trim()).toBe("/users/42");
	});

	it("url() unknown route surfaces as E_INKER_HELPER_THROW", async () => {
		const app = await setupApp();
		const ctx = app.makeCtx();

		let caught: unknown;
		try {
			await app.inker.renderToString(ctx, "url-only", {
				route: "no.such.route",
				id: 1,
			});
		} catch (err) {
			caught = err;
		}
		const inkerErr = asTyped<InkerRenderError>(caught);
		expect(inkerErr.code).toBe("E_INKER_HELPER_THROW");
		expect(asTyped<Error>(inkerErr.cause).message).toMatch(
			/Route 'no\.such\.route' not found/,
		);
	});

	it("asset() returns the manifest hit from config injection", async () => {
		const app = await setupApp({
			inkerConfig: {
				assetManifest: { "logo.png": "/_assets/logo.abc.png" },
			},
		});
		const ctx = app.makeCtx();

		const out = await app.inker.renderToString(ctx, "asset-only", {
			name: "logo.png",
		});

		expect(out.trim()).toBe("/_assets/logo.abc.png");
	});

	it("asset() falls back to /_assets/<name> on a manifest miss", async () => {
		const app = await setupApp({
			inkerConfig: {
				assetManifest: { "app.css": "/_assets/app.x.css" },
			},
		});
		const ctx = app.makeCtx();

		const out = await app.inker.renderToString(ctx, "asset-only", {
			name: "unknown.png",
		});

		expect(out.trim()).toBe("/_assets/unknown.png");
	});

	it("asset() reads <appRoot>/public/manifest.json when no injection", async () => {
		const app = await setupApp(); // no assetManifest in config
		const ctx = app.makeCtx();

		const out = await app.inker.renderToString(ctx, "asset-only", {
			name: "app.css",
		});

		// Fixture's public/manifest.json maps "app.css" → "/_assets/app.hashed.css"
		expect(out.trim()).toBe("/_assets/app.hashed.css");
	});

	it("renderToString returns HTML without touching ctx.response", async () => {
		const app = await setupApp({
			inkerConfig: { assetManifest: { "app.css": "/x" } },
		});
		app.router.get("/users/:id", () => undefined).as("users.update");
		const ctx = app.makeCtx({
			store: new Map([["csrfToken", "TKN"]]),
		});

		await app.inker.renderToString(ctx, "welcome", {
			user: { id: 1, name: "Z" },
		});

		expect(ctx.typeCalls).toEqual([]);
		expect(ctx.sendCalls).toEqual([]);
	});

	it("preserves per-request isolation across concurrent renders", async () => {
		const app = await setupApp();
		const ctxEn = app.makeCtx({ locale: "en" });
		const ctxFr = app.makeCtx({ locale: "fr" });

		const [en, fr] = await Promise.all([
			app.inker.renderToString(ctxEn, "t-only", {
				key: "greeting",
				name: "Ada",
			}),
			app.inker.renderToString(ctxFr, "t-only", {
				key: "greeting",
				name: "Ada",
			}),
		]);

		expect(en.trim()).toBe("Hello, Ada!");
		expect(fr.trim()).toBe("Bonjour, Ada !");
	});

	it("additionalHelpers override warns once then re-uses the override", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const app = await setupApp({
			inkerConfig: {
				additionalHelpers: {
					t: (...args) => {
						const key = String(args[0]);
						return `CUSTOM_${key}`;
					},
				},
			},
		});
		const ctx = app.makeCtx();

		const out1 = await app.inker.renderToString(ctx, "t-only", {
			key: "greeting",
			name: "Ada",
		});
		const out2 = await app.inker.renderToString(ctx, "t-only", {
			key: "greeting",
			name: "Ada",
		});

		expect(out1.trim()).toBe("CUSTOM_greeting");
		expect(out2.trim()).toBe("CUSTOM_greeting");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(/overrides the canonical helper/);
	});
});
