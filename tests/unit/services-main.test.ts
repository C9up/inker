import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type InkerHttpContext,
	InkerRenderer,
} from "../../src/InkerRenderer.js";
import type { Templates } from "../../src/Templates.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";

type ServicesMain = typeof import("../../src/services/main.js");

async function loadFresh(): Promise<ServicesMain> {
	vi.resetModules();
	return import("../../src/services/main.js");
}

function makeRenderer(): InkerRenderer {
	const stub = bypassTypeCheck<Templates>({
		render: async () => "<p>ok</p>",
	});
	return new InkerRenderer(stub, new AsyncLocalStorage<InkerHttpContext>());
}

function makeCtx(): InkerHttpContext {
	return {
		request: {},
		response: { type: () => undefined, send: () => undefined },
		store: new Map(),
		locale: "en",
	};
}

describe("services/main inker singleton", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("throws on pre-bind access with the load-bearing substring", async () => {
		const mod = await loadFresh();
		expect(() => mod.default.renderToString(makeCtx(), "n", {})).toThrow(
			/accessed before InkerProvider\.start\(\)/,
		);
	});

	it("returns undefined from `getInker` before binding", async () => {
		const mod = await loadFresh();
		expect(mod.getInker()).toBeUndefined();
	});

	it("forwards method calls to the bound renderer after `setInker`", async () => {
		const mod = await loadFresh();
		const renderer = makeRenderer();
		mod.setInker(renderer);

		const html = await mod.default.renderToString(makeCtx(), "n", {});

		expect(html).toBe("<p>ok</p>");
		expect(mod.getInker()).toBe(renderer);
	});

	it("returns property values (non-function) through the proxy after binding", async () => {
		const mod = await loadFresh();
		const renderer = makeRenderer();
		mod.setInker(renderer);

		expect(mod.default._templates).toBe(renderer._templates);
	});

	it("binds methods so detached destructuring still works", async () => {
		const mod = await loadFresh();
		const renderer = makeRenderer();
		mod.setInker(renderer);

		const { renderToString } = mod.default;
		const html = await renderToString(makeCtx(), "n", {});

		expect(html).toBe("<p>ok</p>");
	});

	it("replaces the singleton on subsequent `setInker` calls", async () => {
		const mod = await loadFresh();
		const first = makeRenderer();
		const second = makeRenderer();

		mod.setInker(first);
		expect(mod.getInker()).toBe(first);
		mod.setInker(second);
		expect(mod.getInker()).toBe(second);
	});
});
