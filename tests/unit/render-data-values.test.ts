import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";

// Render data is plain JS evaluated in V8 — it never crosses the native
// boundary, so nothing in it is inspected, coerced or refused up front. A
// value only matters when the template actually reads it.

function render(template: string, data: Record<string, unknown>): string {
	return new Templates({ root: os.tmpdir() }).renderString(template, data);
}

function sparseArray(): unknown[] {
	// A genuine hole at index 1, without sparse-literal syntax.
	const sparse: unknown[] = new Array(3);
	sparse[0] = 1;
	sparse[2] = 3;
	return sparse;
}

function cyclic(): Record<string, unknown> {
	const parent: Record<string, unknown> = { name: "p" };
	parent.self = parent;
	return parent;
}

describe("render data — values the template does not read", () => {
	it.each([
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["a cyclic plain object", cyclic()],
		["a sparse array", sparseArray()],
		["a bigint beyond 2^53", 2n ** 64n],
	])("an unused %s field does not stop the render", (_label, value) => {
		expect(render("hello {{ name }}", { name: "Ada", unused: value })).toBe(
			"hello Ada",
		);
	});

	it("renders through render() from disk too", async () => {
		const root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "inker-data-")),
		);
		fs.writeFileSync(path.join(root, "page.inker"), "{{ n }}");
		const t = new Templates({ root });
		expect(
			await t.render("page", { n: 1, avg: Number.NaN, node: cyclic() }),
		).toBe("1");
		expect(t.renderSync("page", { n: 2, big: 2n ** 64n })).toBe("2");
	});
});

describe("render data — values the template prints", () => {
	it("prints NaN and Infinity as JavaScript does", () => {
		expect(
			render("{{ a }}|{{ b }}|{{ c }}", {
				a: Number.NaN,
				b: Number.POSITIVE_INFINITY,
				c: Number.NEGATIVE_INFINITY,
			}),
		).toBe("NaN|Infinity|-Infinity");
	});

	it("prints a bigint of any size exactly", () => {
		expect(render("{{ n }}", { n: 2n ** 64n })).toBe("18446744073709551616");
		expect(render("{{ n }}", { n: 42n })).toBe("42");
	});

	it("reads through a cycle", () => {
		expect(render("{{ node.self.self.name }}", { node: cyclic() })).toBe("p");
	});

	it("iterates a sparse array with undefined for each hole", () => {
		expect(
			render("@each((v, i) in arr)[{{ i }}:{{ v }}]@endeach", {
				arr: sparseArray(),
			}),
		).toBe("[0:1][1:][2:3]");
	});

	it("renders undefined and null identically (empty)", () => {
		expect(render("[{{ x }}]", { x: undefined })).toBe("[]");
		expect(render("[{{ x }}]", { x: null })).toBe("[]");
	});

	it("treats an undefined own-property as falsy in a condition", () => {
		expect(render("@if(x)Y@else\nN@endif", { x: undefined })).toBe("N");
	});
});

describe("render data — objects interpolated through their string form", () => {
	class Money {
		readonly amount: number;
		constructor(amount: number) {
			this.amount = amount;
		}
		toString(): string {
			return `<b>${this.amount} EUR</b>`;
		}
	}

	it("prints a Date through String()", () => {
		const d = new Date(0);
		expect(render("{{ d }}", { d })).toBe(String(d));
	});

	it("escapes what a toString() returns", () => {
		expect(render("{{ m }}", { m: new Money(1.5) })).toBe(
			"&lt;b&gt;1.5 EUR&lt;/b&gt;",
		);
	});

	it("comma-joins an array and escapes its entries", () => {
		expect(render("{{ a }}", { a: ["<x>", "y"] })).toBe("&lt;x&gt;,y");
	});

	it("emits String(value) unescaped in {{{ }}}", () => {
		expect(render("{{{ o }}}", { o: { a: 1 } })).toBe("[object Object]");
		expect(render("{{{ m }}}", { m: new Money(2) })).toBe("<b>2 EUR</b>");
	});

	it("still emits a SafeString verbatim", () => {
		expect(render("{{ html.safe(s) }}", { s: "<i>x</i>" })).toBe("<i>x</i>");
	});

	it("reports a value that has no string form as a typed error", () => {
		const bare: object = Object.create(null);
		const throwing = {
			toString(): string {
				throw new Error("boom");
			},
		};
		for (const value of [bare, throwing]) {
			try {
				render("{{ v }}", { v: value });
				expect.fail("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(InkerRenderError);
				if (e instanceof InkerRenderError) {
					expect(e.code).toBe("E_INKER_INVALID_EXPRESSION");
				}
			}
		}
	});
});
