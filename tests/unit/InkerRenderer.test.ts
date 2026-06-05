import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import {
	type InkerHttpContext,
	InkerRenderer,
} from "../../src/InkerRenderer.js";
import type { Templates } from "../../src/Templates.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";

interface TestCtx extends InkerHttpContext {
	typeCalls: string[];
	sendCalls: string[];
}

function makeCtx(overrides: Partial<InkerHttpContext> = {}): TestCtx {
	const typeCalls: string[] = [];
	const sendCalls: string[] = [];
	return {
		request: {},
		response: {
			type(value: string) {
				typeCalls.push(value);
				return undefined;
			},
			send(body: string) {
				sendCalls.push(body);
				return undefined;
			},
		},
		store: new Map<string, unknown>(),
		locale: "en",
		typeCalls,
		sendCalls,
		...overrides,
	};
}

function makeStubTemplates(
	renderImpl: (
		name: string,
		data: Readonly<Record<string, unknown>>,
	) => string | Promise<string>,
): Templates {
	return bypassTypeCheck<Templates>({
		render: (name: string, data: Readonly<Record<string, unknown>>) =>
			Promise.resolve(renderImpl(name, data)),
	});
}

describe("InkerRenderer", () => {
	describe("render(ctx, name, data)", () => {
		it("calls templates.render once with the same name + data", async () => {
			const calls: Array<{
				name: string;
				data: Readonly<Record<string, unknown>>;
			}> = [];
			const stub = bypassTypeCheck<Templates>({
				render: async (
					name: string,
					data: Readonly<Record<string, unknown>>,
				) => {
					calls.push({ name, data });
					return "<p>hi</p>";
				},
			});
			const als = new AsyncLocalStorage<InkerHttpContext>();
			const renderer = new InkerRenderer(stub, als);
			const ctx = makeCtx();

			await renderer.render(ctx, "welcome", { user: "ada" });

			expect(calls).toHaveLength(1);
			expect(calls[0]?.name).toBe("welcome");
			expect(calls[0]?.data).toEqual({ user: "ada" });
		});

		it("sets content-type to text/html; charset=utf-8", async () => {
			const renderer = new InkerRenderer(
				makeStubTemplates(() => "<p>hi</p>"),
				new AsyncLocalStorage<InkerHttpContext>(),
			);
			const ctx = makeCtx();

			await renderer.render(ctx, "n", {});

			expect(ctx.typeCalls).toEqual(["text/html; charset=utf-8"]);
		});

		it("writes the rendered body via ctx.response.send", async () => {
			const renderer = new InkerRenderer(
				makeStubTemplates(() => "<h1>Hello</h1>"),
				new AsyncLocalStorage<InkerHttpContext>(),
			);
			const ctx = makeCtx();

			await renderer.render(ctx, "n", {});

			expect(ctx.sendCalls).toEqual(["<h1>Hello</h1>"]);
		});

		it("resolves to undefined", async () => {
			const renderer = new InkerRenderer(
				makeStubTemplates(() => "html"),
				new AsyncLocalStorage<InkerHttpContext>(),
			);
			const ctx = makeCtx();

			const result = await renderer.render(ctx, "n", {});

			expect(result).toBeUndefined();
		});

		it("populates the ALS frame for the duration of templates.render", async () => {
			const als = new AsyncLocalStorage<InkerHttpContext>();
			let storeInsideRender: InkerHttpContext | undefined;
			const renderer = new InkerRenderer(
				makeStubTemplates(() => {
					storeInsideRender = als.getStore();
					return "ok";
				}),
				als,
			);
			const ctx = makeCtx({ locale: "fr" });

			await renderer.render(ctx, "n", {});

			expect(storeInsideRender).toBe(ctx);
		});

		it("clears the ALS frame after render resolves", async () => {
			const als = new AsyncLocalStorage<InkerHttpContext>();
			const renderer = new InkerRenderer(
				makeStubTemplates(() => "ok"),
				als,
			);
			const ctx = makeCtx();

			await renderer.render(ctx, "n", {});

			expect(als.getStore()).toBeUndefined();
		});
	});

	describe("renderToString(ctx, name, data)", () => {
		it("returns the HTML string without writing to ctx.response", async () => {
			const renderer = new InkerRenderer(
				makeStubTemplates(() => "<p>x</p>"),
				new AsyncLocalStorage<InkerHttpContext>(),
			);
			const ctx = makeCtx();

			const html = await renderer.renderToString(ctx, "n", {});

			expect(html).toBe("<p>x</p>");
			expect(ctx.typeCalls).toEqual([]);
			expect(ctx.sendCalls).toEqual([]);
		});

		it("wraps templates.render in the same ALS frame as render()", async () => {
			const als = new AsyncLocalStorage<InkerHttpContext>();
			let storeInsideRender: InkerHttpContext | undefined;
			const renderer = new InkerRenderer(
				makeStubTemplates(() => {
					storeInsideRender = als.getStore();
					return "ok";
				}),
				als,
			);
			const ctx = makeCtx({ locale: "de" });

			await renderer.renderToString(ctx, "n", {});

			expect(storeInsideRender).toBe(ctx);
			expect(als.getStore()).toBeUndefined();
		});
	});

	describe("concurrent isolation", () => {
		it("preserves per-frame ctx across interleaved renders", async () => {
			const als = new AsyncLocalStorage<InkerHttpContext>();
			const seen: Array<string | undefined> = [];
			const renderer = new InkerRenderer(
				makeStubTemplates(async () => {
					// Yield to the event loop so the two renders interleave.
					await new Promise((r) => setTimeout(r, 0));
					seen.push(als.getStore()?.locale);
					return "ok";
				}),
				als,
			);
			const ctxEn = makeCtx({ locale: "en" });
			const ctxFr = makeCtx({ locale: "fr" });

			await Promise.all([
				renderer.renderToString(ctxEn, "a", {}),
				renderer.renderToString(ctxFr, "b", {}),
			]);

			expect(seen).toHaveLength(2);
			expect(seen).toContain("en");
			expect(seen).toContain("fr");
		});
	});

	describe("_templates seam", () => {
		it("exposes the underlying Templates instance", () => {
			const stub = makeStubTemplates(() => "");
			const renderer = new InkerRenderer(
				stub,
				new AsyncLocalStorage<InkerHttpContext>(),
			);

			expect(renderer._templates).toBe(stub);
		});
	});
});
