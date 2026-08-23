/**
 * `ctx.view` — a renderer per request, the way AdonisJS's edge provider
 * installs it (`HttpContext.getter('view', …)`, singleton). Every migrated
 * controller calls `ctx.view.render(...)`, so its absence broke all of them.
 *
 * inker resolves the context class from the CONTAINER rather than importing the
 * host framework, so this stays agnostic.
 */
import { describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";
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
