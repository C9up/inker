import os from "node:os";
import { describe, expect, it } from "vitest";
import { LruCache } from "../../src/lruCache.js";
import {
	COMPILED_EXPRESSION_CAPACITY,
	compiledExpressionCount,
} from "../../src/renderNode.js";
import { Templates } from "../../src/Templates.js";

describe("LruCache", () => {
	it("evicts the least recently used entry past its capacity", () => {
		const cache = new LruCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		expect(cache.get("a")).toBe(1); // `a` is now the most recent
		cache.set("c", 3);
		expect(cache.size).toBe(2);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe(1);
		expect(cache.get("c")).toBe(3);
	});

	it("empties on clear", () => {
		const cache = new LruCache<string, number>(2);
		cache.set("a", 1);
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.get("a")).toBeUndefined();
	});
});

describe("compiled expression cache", () => {
	it("stays bounded however many distinct expressions are rendered", () => {
		const t = new Templates({ root: os.tmpdir() });
		for (let i = 0; i < COMPILED_EXPRESSION_CAPACITY + 50; i++) {
			expect(t.renderString(`{{ ${i} + 1 }}`)).toBe(String(i + 1));
		}
		expect(compiledExpressionCount()).toBe(COMPILED_EXPRESSION_CAPACITY);
		// The evicted ones still render: they are compiled again on demand.
		expect(t.renderString("{{ 0 + 1 }}")).toBe("1");
	});

	it("is emptied by Templates#clearCache", () => {
		const t = new Templates({ root: os.tmpdir() });
		t.renderString("{{ 'x' + 1 }}");
		expect(compiledExpressionCount()).toBeGreaterThan(0);
		t.clearCache();
		expect(compiledExpressionCount()).toBe(0);
	});
});
