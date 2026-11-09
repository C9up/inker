import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";

// Partials and components behave as if they were resolved when they render
// (Edge compiles them lazily): recursion ends on the data, an untaken branch
// never needs its template, and runaway recursion hits a typed depth cap.

function withFiles(files: Record<string, string>): Templates {
	const root = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-lazy-")),
	);
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(root, `${name}.inker`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, source);
	}
	return new Templates({ root, cacheMode: "never" });
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof InkerRenderError) return e.code;
		throw e;
	}
	throw new Error("expected an InkerRenderError");
}

const tree = {
	name: "root",
	children: [{ name: "kid", children: [{ name: "leaf", children: [] }] }],
};

describe("recursive components and partials", () => {
	it("renders a self-recursive tree component three levels deep", async () => {
		const t = withFiles({
			"components/tree":
				"<li>{{ node.name }}@if(node.children.length)<ul>@each(c in node.children)@!component('tree', { node: c })@end</ul>@end</li>",
			page: "@!component('tree', { node: tree })",
		});
		const expected = "<li>root<ul><li>kid<ul><li>leaf</li></ul></li></ul></li>";
		expect(await t.render("page", { tree })).toBe(expected);
		expect(t.renderSync("page", { tree })).toBe(expected);
	});

	it("terminates mutual recursion A → B → A on the data", async () => {
		const t = withFiles({
			"partials/a":
				"A{{ n }}@if(n > 0)@let(n = n - 1)@include('partials/b')@end",
			"partials/b": "B{{ n }}@include('partials/a')",
			page: "@include('partials/a')",
		});
		expect(await t.render("page", { n: 2 })).toBe("A2B1A1B0A0");
	});

	it("stops unbounded recursion with a typed depth error", async () => {
		const t = withFiles({
			"components/card": "@!component('card')",
			"partials/loop": "@include('partials/loop')",
			page: "@!component('card')",
			partial: "@include('partials/loop')",
		});
		expect(await codeOf(() => t.render("page"))).toBe("E_INKER_RENDER_DEPTH");
		expect(await codeOf(() => t.render("partial"))).toBe(
			"E_INKER_RENDER_DEPTH",
		);
	});
});

describe("templates behind an untaken branch", () => {
	it("renders @includeIf(false) of a missing partial", async () => {
		const t = withFiles({ page: "start@includeIf(false, 'partials/missing')" });
		expect(await t.render("page")).toBe("start");
	});

	it("renders @if(false) around a missing component", async () => {
		const t = withFiles({ page: "start@if(false)@!component('missing')@end" });
		expect(await t.render("page")).toBe("start");
		expect(t.renderSync("page")).toBe("start");
	});

	it("still reports a missing template that does render", async () => {
		const t = withFiles({
			page: "start@includeIf(true, 'partials/missing')",
			comp: "@!component('missing')",
		});
		expect(await codeOf(() => t.render("page"))).toBe(
			"E_INKER_TEMPLATE_NOT_FOUND",
		);
		expect(await codeOf(() => t.render("comp"))).toBe(
			"E_INKER_TEMPLATE_NOT_FOUND",
		);
	});
});
