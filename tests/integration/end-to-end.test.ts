import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";
import { asTyped } from "../__helpers__/bypass-type-check.js";

function bumpMtime(file: string, deltaSeconds: number): void {
	const future = Date.now() / 1000 + deltaSeconds;
	fs.utimesSync(file, future, future);
}

describe("Templates — end-to-end FS round-trip", () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "inker-e2e-"));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("loads .inker from disk, escapes by default, returns the rendered string", async () => {
		fs.writeFileSync(
			path.join(root, "invoice.inker"),
			"<h1>Invoice for {{ customer.name }}</h1>\nTotal: {{ total }}",
		);

		const templates = new Templates({ root, cacheMode: "mtime" });
		const out = await templates.render("invoice", {
			customer: { name: "<Alice>" },
			total: 42,
		});

		expect(out).toBe("<h1>Invoice for &lt;Alice&gt;</h1>\nTotal: 42");
	});

	it("cacheMode 'mtime' reflects on-disk mutations on next render", async () => {
		const file = path.join(root, "greet.inker");
		fs.writeFileSync(file, "Hi {{ name }}");
		const templates = new Templates({ root, cacheMode: "mtime" });

		expect(await templates.render("greet", { name: "Alice" })).toBe("Hi Alice");

		fs.writeFileSync(file, "Hello {{ name }}");
		bumpMtime(file, 10);

		expect(await templates.render("greet", { name: "Bob" })).toBe("Hello Bob");
	});

	it("cacheMode 'never' (prod posture) keeps the original parse — disk edits do not surface", async () => {
		const file = path.join(root, "frozen.inker");
		fs.writeFileSync(file, "v1 {{ tag }}");
		const templates = new Templates({ root, cacheMode: "never" });

		expect(await templates.render("frozen", { tag: "alpha" })).toBe("v1 alpha");

		fs.writeFileSync(file, "v2 {{ tag }}");
		bumpMtime(file, 10);

		expect(await templates.render("frozen", { tag: "beta" })).toBe("v1 beta");
	});
});

describe("Templates — layouts and partials", () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "inker-layout-"));
		fs.mkdirSync(path.join(root, "layouts"));
		fs.mkdirSync(path.join(root, "partials"));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("renders a single-layout golden path", async () => {
		fs.writeFileSync(
			path.join(root, "layouts/main.inker"),
			"<html><body>{{> body }}</body></html>",
		);
		fs.writeFileSync(
			path.join(root, "invoice.inker"),
			"{% layout 'layouts/main' %}<h1>Invoice for {{ name }}</h1>",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		expect(await templates.render("invoice", { name: "Alice" })).toBe(
			"<html><body><h1>Invoice for Alice</h1></body></html>",
		);
	});

	it("layout includes a partial (footer)", async () => {
		fs.writeFileSync(
			path.join(root, "partials/footer.inker"),
			"<footer>(c)</footer>",
		);
		fs.writeFileSync(
			path.join(root, "layouts/main.inker"),
			"<html><body>{{> body }}{% include 'partials/footer' %}</body></html>",
		);
		fs.writeFileSync(
			path.join(root, "invoice.inker"),
			"{% layout 'layouts/main' %}<h1>Invoice for {{ name }}</h1>",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		expect(await templates.render("invoice", { name: "Alice" })).toBe(
			"<html><body><h1>Invoice for Alice</h1><footer>(c)</footer></body></html>",
		);
	});

	it("child includes a partial after the layout directive", async () => {
		fs.writeFileSync(path.join(root, "partials/header.inker"), "<h1>HDR</h1>");
		fs.writeFileSync(
			path.join(root, "layouts/main.inker"),
			"<html>{{> body }}</html>",
		);
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% layout 'layouts/main' %}{% include 'partials/header' %}<p>{{ msg }}</p>",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		expect(await templates.render("page", { msg: "hi" })).toBe(
			"<html><h1>HDR</h1><p>hi</p></html>",
		);
	});

	it("recursive partial — partial-includes-partial", async () => {
		fs.writeFileSync(path.join(root, "partials/inner.inker"), "[inner]");
		fs.writeFileSync(
			path.join(root, "partials/wrap.inker"),
			"(wrap{% include 'partials/inner' %})",
		);
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"X{% include 'partials/wrap' %}Y",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		expect(await templates.render("page", {})).toBe("X(wrap[inner])Y");
	});

	it("circular include — partials a → b → a throws E_INKER_CIRCULAR_INCLUDE", async () => {
		fs.writeFileSync(
			path.join(root, "partials/a.inker"),
			"A:{% include 'partials/b' %}",
		);
		fs.writeFileSync(
			path.join(root, "partials/b.inker"),
			"B:{% include 'partials/a' %}",
		);
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% include 'partials/a' %}",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", {});
			expect.fail("should have thrown");
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_CIRCULAR_INCLUDE");
			expect(err.message).toContain("partials/a");
			expect(err.message).toContain("partials/b");
		}
	});

	it("nested layout — layouts/main.inker contains {% layout 'other' %} throws", async () => {
		fs.writeFileSync(
			path.join(root, "layouts/other.inker"),
			"<other>{{> body }}</other>",
		);
		fs.writeFileSync(
			path.join(root, "layouts/main.inker"),
			"{% layout 'layouts/other' %}<m>{{> body }}</m>",
		);
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% layout 'layouts/main' %}body",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", {});
			expect.fail("should have thrown");
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_NESTED_LAYOUT_UNSUPPORTED");
			expect(err.context.templatePath).toBe(
				path.join(root, "layouts/main.inker"),
			);
		}
	});

	it("layout-in-partial — partial contains {% layout %} throws", async () => {
		fs.writeFileSync(
			path.join(root, "layouts/main.inker"),
			"<m>{{> body }}</m>",
		);
		fs.writeFileSync(
			path.join(root, "partials/bad.inker"),
			"{% layout 'layouts/main' %}sneaky",
		);
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% include 'partials/bad' %}",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", {});
			expect.fail("should have thrown");
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_LAYOUT_IN_PARTIAL");
			expect(err.context.templatePath).toBe(
				path.join(root, "partials/bad.inker"),
			);
		}
	});

	it("missing slot — layout has no {{> body }} and child has content throws", async () => {
		fs.writeFileSync(path.join(root, "layouts/empty.inker"), "<html></html>");
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% layout 'layouts/empty' %}content",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", {});
			expect.fail("should have thrown");
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_MISSING_SLOT");
			expect(err.message).toContain("layouts/empty");
			expect(err.message).toContain("page");
		}
	});

	it("empty body is OK — layout-only render returns the layout verbatim (D10)", async () => {
		fs.writeFileSync(
			path.join(root, "layouts/main.inker"),
			"<html><body>{{> body }}</body></html>",
		);
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% layout 'layouts/main' %}",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		expect(await templates.render("page", {})).toBe(
			"<html><body></body></html>",
		);
	});

	it("unknown slot in layout — `{{> head }}` throws at composition time", async () => {
		fs.writeFileSync(
			path.join(root, "layouts/main.inker"),
			"<html>{{> head }}{{> body }}</html>",
		);
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% layout 'layouts/main' %}body",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", {});
			expect.fail("should have thrown");
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_UNKNOWN_SLOT");
			expect(err.message).toContain("head");
			expect(err.context.templatePath).toBe(
				path.join(root, "layouts/main.inker"),
			);
		}
	});

	it("path-traversal in include — `{% include '../etc/passwd' %}` rejected at parse", async () => {
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% include '../etc/passwd' %}",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", {});
			expect.fail("should have thrown");
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_PARSE_ERROR");
		}
	});

	it("cacheMode mtime — layout edit is picked up on next render", async () => {
		const layout = path.join(root, "layouts/main.inker");
		fs.writeFileSync(layout, "<L1>{{> body }}</L1>");
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% layout 'layouts/main' %}<p>x</p>",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });

		expect(await templates.render("page", {})).toBe("<L1><p>x</p></L1>");

		fs.writeFileSync(layout, "<L2>{{> body }}</L2>");
		bumpMtime(layout, 10);

		expect(await templates.render("page", {})).toBe("<L2><p>x</p></L2>");
	});

	it("cacheMode mtime — partial edit is picked up on next render", async () => {
		const partial = path.join(root, "partials/footer.inker");
		fs.writeFileSync(partial, "<f1>");
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"start{% include 'partials/footer' %}end",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });

		expect(await templates.render("page", {})).toBe("start<f1>end");

		fs.writeFileSync(partial, "<f2>");
		bumpMtime(partial, 10);

		expect(await templates.render("page", {})).toBe("start<f2>end");
	});

	it("cacheMode never — layout/partial edits NOT picked up (prod posture)", async () => {
		// Behaviour-pinned, see Spec Deviations / D3 — 'never' = never invalidate.
		const layout = path.join(root, "layouts/main.inker");
		const partial = path.join(root, "partials/footer.inker");
		fs.writeFileSync(
			layout,
			"<L1>{{> body }}{% include 'partials/footer' %}</L1>",
		);
		fs.writeFileSync(partial, "<f1>");
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% layout 'layouts/main' %}<p>x</p>",
		);
		const templates = new Templates({ root, cacheMode: "never" });

		expect(await templates.render("page", {})).toBe("<L1><p>x</p><f1></L1>");

		fs.writeFileSync(
			layout,
			"<L2>{{> body }}{% include 'partials/footer' %}</L2>",
		);
		fs.writeFileSync(partial, "<f2>");
		bumpMtime(layout, 10);
		bumpMtime(partial, 10);

		expect(await templates.render("page", {})).toBe("<L1><p>x</p><f1></L1>");
	});

	it("data scope inheritance — partials see the parent data verbatim (D4)", async () => {
		fs.writeFileSync(
			path.join(root, "partials/greet.inker"),
			"Hello {{ name }}",
		);
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"{% include 'partials/greet' %}",
		);
		const templates = new Templates({ root, cacheMode: "mtime" });
		expect(await templates.render("page", { name: "Alice" })).toBe(
			"Hello Alice",
		);
	});

	// --- 53.3 control flow + components end-to-end ---

	function write(p: string, contents: string): string {
		const file = path.join(root, p);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, contents);
		return file;
	}

	describe("control flow + components (53.3)", () => {
		it("layout + partial + component compose together", async () => {
			write("main.inker", "<html><body>{{> body }}</body></html>");
			write("partials/header.inker", "<header>{{ title }}</header>");
			write("components/badge.inker", "<span>{{ label }}</span>");
			write(
				"page.inker",
				"{% layout 'main' %}{% include 'partials/header' %} {% component 'badge' { label: page.label } %}",
			);
			const templates = new Templates({ root, cacheMode: "mtime" });
			expect(
				await templates.render("page", {
					title: "Welcome",
					page: { label: "NEW" },
				}),
			).toBe(
				"<html><body><header>Welcome</header> <span>NEW</span></body></html>",
			);
		});

		it("renders a list of components inside an each loop", async () => {
			write("components/user-card.inker", "<li>{{ name }} ({{ email }})</li>");
			write(
				"page.inker",
				"<ul>{% each users as user %}{% component 'user-card' { name: user.name, email: user.email } %}{% endeach %}</ul>",
			);
			const templates = new Templates({ root, cacheMode: "mtime" });
			const out = await templates.render("page", {
				users: [
					{ name: "Alice", email: "a@x" },
					{ name: "Bob", email: "b@x" },
				],
			});
			expect(out).toBe("<ul><li>Alice (a@x)</li><li>Bob (b@x)</li></ul>");
		});

		it("renders nested-conditional rendering with each/else", async () => {
			write(
				"page.inker",
				"{% if showAll %}{% each items as item %}<{{ item }}>{% else %}EMPTY{% endeach %}{% else %}HIDDEN{% endif %}",
			);
			const templates = new Templates({ root, cacheMode: "mtime" });
			expect(
				await templates.render("page", {
					showAll: true,
					items: ["a", "b"],
				}),
			).toBe("<a><b>");
			expect(await templates.render("page", { showAll: true, items: [] })).toBe(
				"EMPTY",
			);
			expect(
				await templates.render("page", { showAll: false, items: [] }),
			).toBe("HIDDEN");
		});

		it("detects component cycle (card→card) on disk fixture", async () => {
			write("components/card.inker", "{% component 'card' {} %}");
			write("page.inker", "{% component 'card' {} %}");
			const templates = new Templates({ root, cacheMode: "mtime" });
			try {
				await templates.render("page", {});
				expect.fail();
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe(
					"E_INKER_CIRCULAR_INCLUDE",
				);
			}
		});

		it("component cache hit (mtime unchanged → cached AST)", async () => {
			const file = write("components/card.inker", "[{{ title }}]");
			write("page.inker", "{% component 'card' { title: page.title } %}");
			const templates = new Templates({ root, cacheMode: "mtime" });
			expect(await templates.render("page", { page: { title: "v1" } })).toBe(
				"[v1]",
			);
			// Same mtime — second render reuses the cached AST.
			expect(await templates.render("page", { page: { title: "v2" } })).toBe(
				"[v2]",
			);
			fs.writeFileSync(file, "<{{ title }}>");
			bumpMtime(file, 10);
			expect(await templates.render("page", { page: { title: "v3" } })).toBe(
				"<v3>",
			);
		});

		it("component-in-each-in-layout composes through the full pipeline", async () => {
			write("main.inker", "<main>{{> body }}</main>");
			write("components/row.inker", "<li>{{ value }}</li>");
			write(
				"page.inker",
				"{% layout 'main' %}<ul>{% each items as v %}{% component 'row' { value: v } %}{% endeach %}</ul>",
			);
			const templates = new Templates({ root, cacheMode: "mtime" });
			expect(await templates.render("page", { items: ["X", "Y", "Z"] })).toBe(
				"<main><ul><li>X</li><li>Y</li><li>Z</li></ul></main>",
			);
		});

		it("rejects {% if x %} in renderString (recursive disk-walk catches Component inside If)", () => {
			const templates = new Templates({ root, cacheMode: "mtime" });
			expect(() =>
				templates.renderString(
					"{% if x %}{% component 'card' {} %}{% endif %}",
					{ x: true },
				),
			).toThrowError(/E_INKER_DISK_REQUIRED|component/);
		});

		it("rejects {% each %} containing {% include %} in renderString", () => {
			const templates = new Templates({ root, cacheMode: "mtime" });
			expect(() =>
				templates.renderString(
					"{% each items as x %}{% include 'partials/y' %}{% endeach %}",
					{ items: [] },
				),
			).toThrowError(/E_INKER_DISK_REQUIRED|include/);
		});

		it("each over null hint mentions {% if %} wrapper", async () => {
			write("page.inker", "{% each items as item %}row{% endeach %}");
			const templates = new Templates({ root, cacheMode: "mtime" });
			try {
				await templates.render("page", { items: null });
				expect.fail();
			} catch (e) {
				const err = asTyped<InkerRenderError>(e);
				expect(err.code).toBe("E_INKER_INVALID_ITERABLE");
				expect(err.message).toContain("if");
			}
		});

		it("propagates resolvePath line/column in error context for if condition", async () => {
			write("page.inker", "line1\nline2 {% if x.y.z %}T{% endif %}");
			const templates = new Templates({ root, cacheMode: "mtime" });
			try {
				await templates.render("page", { x: null });
				expect.fail();
			} catch (e) {
				const err = asTyped<InkerRenderError>(e);
				expect(err.code).toBe("E_INKER_UNKNOWN_IDENTIFIER");
				expect(err.context.line).toBeGreaterThan(0);
			}
		});
	});
});
