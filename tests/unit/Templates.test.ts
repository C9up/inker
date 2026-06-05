import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";
import { asTyped } from "../__helpers__/bypass-type-check.js";

function makeTempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "inker-templates-"));
}

function bumpMtime(file: string, deltaSeconds: number): void {
	const future = Date.now() / 1000 + deltaSeconds;
	fs.utimesSync(file, future, future);
}

describe("Templates — construction", () => {
	it("throws E_INKER_INVALID_PATH for a relative root", () => {
		try {
			new Templates({ root: "./foo" });
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(InkerRenderError);
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
		}
	});

	it("throws E_INKER_INVALID_PATH when root does not exist", () => {
		const root = path.join(os.tmpdir(), "inker-no-such-dir-9999");
		try {
			new Templates({ root });
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
		}
	});

	it("throws E_INKER_INVALID_PATH when root points at a file", () => {
		const dir = makeTempRoot();
		const file = path.join(dir, "not-a-dir.inker");
		fs.writeFileSync(file, "x");
		try {
			new Templates({ root: file });
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Templates — render() filesystem behaviour", () => {
	let root: string;

	beforeEach(() => {
		root = makeTempRoot();
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("throws E_INKER_TEMPLATE_NOT_FOUND with absolute path in context", async () => {
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("missing", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(InkerRenderError);
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_TEMPLATE_NOT_FOUND");
			expect(err.context.templatePath).toBe(path.join(root, "missing.inker"));
		}
	});

	it("renderString round-trips a simple template", () => {
		const templates = new Templates({ root });
		expect(
			templates.renderString("<h1>{{ greeting }}</h1>", {
				greeting: "Hi",
			}),
		).toBe("<h1>Hi</h1>");
	});

	it("renderString throws E_INKER_UNKNOWN_IDENTIFIER for missing data", () => {
		const templates = new Templates({ root });
		try {
			templates.renderString("{{ x }}", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe(
				"E_INKER_UNKNOWN_IDENTIFIER",
			);
		}
	});

	it("renderString throws a clear error on circular render data (not a stack overflow)", () => {
		const templates = new Templates({ root });
		const cyclic: Record<string, unknown> = { name: "x" };
		cyclic.self = cyclic;
		try {
			templates.renderString("hi {{ name }}", cyclic);
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe(
				"E_INKER_INVALID_EXPRESSION",
			);
		}
	});

	it("renderString renders an integer-valued number without a trailing .0 (JS String semantics)", () => {
		const templates = new Templates({ root });
		expect(templates.renderString("{{ n }}", { n: 100 })).toBe("100");
		expect(templates.renderString("{{ 100 }}", {})).toBe("100");
	});

	it("renderString throws E_INKER_DISK_REQUIRED on {% layout %}", () => {
		const templates = new Templates({ root });
		try {
			templates.renderString("{% layout 'main' %}hi", {});
			expect.fail("should have thrown");
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_DISK_REQUIRED");
			expect(err.message).toContain("layout");
		}
	});

	it("renderString throws E_INKER_DISK_REQUIRED on {% include %}", () => {
		const templates = new Templates({ root });
		try {
			templates.renderString("{% include 'partials/x' %}", {});
			expect.fail("should have thrown");
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_DISK_REQUIRED");
			expect(err.message).toContain("include");
		}
	});

	it("renderString throws E_INKER_DISK_REQUIRED on {{> body }} (no parent)", () => {
		const templates = new Templates({ root });
		try {
			templates.renderString("{{> body }}", {});
			expect.fail("should have thrown");
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_DISK_REQUIRED");
			expect(err.message).toContain("slot");
		}
	});

	it("renderString still works on pure interpolation (no regression)", () => {
		const templates = new Templates({ root });
		expect(templates.renderString("<h1>{{ name }}</h1>", { name: "Hi" })).toBe(
			"<h1>Hi</h1>",
		);
	});
});

describe("Templates — cache semantics", () => {
	let root: string;

	beforeEach(() => {
		root = makeTempRoot();
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("auto mode with NODE_ENV=production serves stale AST after on-disk edit (cached forever)", async () => {
		const file = path.join(root, "p.inker");
		fs.writeFileSync(file, "FIRST {{ x }}");
		vi.stubEnv("NODE_ENV", "production");
		const templates = new Templates({ root });

		const first = await templates.render("p", { x: "a" });
		expect(first).toBe("FIRST a");

		fs.writeFileSync(file, "SECOND {{ x }}");
		bumpMtime(file, 10);

		const second = await templates.render("p", { x: "b" });
		// proves the prod-mode "never re-stat" semantic: second render
		// served from cache despite the disk mutation.
		expect(second).toBe("FIRST b");
	});

	it("auto mode with NODE_ENV undefined behaves as mtime (re-reads on disk edit)", async () => {
		const file = path.join(root, "d.inker");
		fs.writeFileSync(file, "FIRST {{ x }}");
		vi.stubEnv("NODE_ENV", "development");
		const templates = new Templates({ root });

		expect(await templates.render("d", { x: "a" })).toBe("FIRST a");
		fs.writeFileSync(file, "SECOND {{ x }}");
		bumpMtime(file, 10);
		expect(await templates.render("d", { x: "b" })).toBe("SECOND b");
	});

	it("mtime mode re-parses after the file mtime advances", async () => {
		const file = path.join(root, "m.inker");
		fs.writeFileSync(file, "A={{ a }}");
		const templates = new Templates({ root, cacheMode: "mtime" });

		expect(await templates.render("m", { a: 1 })).toBe("A=1");

		fs.writeFileSync(file, "B={{ a }}");
		bumpMtime(file, 10);

		expect(await templates.render("m", { a: 2 })).toBe("B=2");
	});

	it("mtime mode returns cached output when mtime is unchanged after disk edit", async () => {
		// Same mtime but mutated content: the cache wins (proves the mtime check is the
		// only re-parse trigger — not byte-level content comparison).
		const file = path.join(root, "u.inker");
		fs.writeFileSync(file, "ORIGINAL");
		const fixedStamp = Date.now() / 1000 - 1000;
		fs.utimesSync(file, fixedStamp, fixedStamp);
		const templates = new Templates({ root, cacheMode: "mtime" });

		expect(await templates.render("u", {})).toBe("ORIGINAL");
		fs.writeFileSync(file, "MUTATED");
		fs.utimesSync(file, fixedStamp, fixedStamp);
		expect(await templates.render("u", {})).toBe("ORIGINAL");
	});

	it("never mode caches forever — disk edit does not surface in subsequent renders", async () => {
		// Per AC9 step 2 ("cacheMode === 'never' AND cache has absPath → return entry.ast")
		// and D3 ("never re-stat = prod posture"). The "never" naming refers to "never
		// invalidate", not "never cache". AC11's wording ("every render re-reads")
		// contradicts AC9 step 2; we align with AC9 (the runtime contract) and document
		// the divergence in ### Spec Deviations.
		const file = path.join(root, "n.inker");
		fs.writeFileSync(file, "OLD {{ x }}");
		const templates = new Templates({ root, cacheMode: "never" });

		expect(await templates.render("n", { x: "a" })).toBe("OLD a");

		fs.writeFileSync(file, "NEW {{ x }}");
		bumpMtime(file, 10);

		expect(await templates.render("n", { x: "b" })).toBe("OLD b");
		expect(await templates.render("n", { x: "c" })).toBe("OLD c");
	});

	it("clearCache() after a layout-using render re-reads BOTH entry AND layout", async () => {
		const layout = path.join(root, "main.inker");
		const child = path.join(root, "child.inker");
		fs.writeFileSync(layout, "<L1>{{> body }}</L1>");
		fs.writeFileSync(child, "{% layout 'main' %}<p>old</p>");
		vi.stubEnv("NODE_ENV", "production");
		const templates = new Templates({ root });

		expect(await templates.render("child", {})).toBe("<L1><p>old</p></L1>");

		fs.writeFileSync(layout, "<L2>{{> body }}</L2>");
		fs.writeFileSync(child, "{% layout 'main' %}<p>new</p>");
		bumpMtime(layout, 10);
		bumpMtime(child, 10);

		// Without clearCache, prod mode keeps both entries hot.
		expect(await templates.render("child", {})).toBe("<L1><p>old</p></L1>");

		templates.clearCache();
		expect(await templates.render("child", {})).toBe("<L2><p>new</p></L2>");
	});

	it("clearCache() forces the next render to re-read the file", async () => {
		const file = path.join(root, "c.inker");
		fs.writeFileSync(file, "OLD {{ x }}");
		vi.stubEnv("NODE_ENV", "production");
		const templates = new Templates({ root });

		expect(await templates.render("c", { x: 1 })).toBe("OLD 1");

		// Mutate without bumping mtime — under prod mode the cache stays hot.
		fs.writeFileSync(file, "NEW {{ x }}");
		bumpMtime(file, 10);
		expect(await templates.render("c", { x: 2 })).toBe("OLD 2");

		templates.clearCache();
		expect(await templates.render("c", { x: 3 })).toBe("NEW 3");
	});
});

describe("Templates — component resolution (53.3)", () => {
	let root: string;

	beforeEach(() => {
		root = makeTempRoot();
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function write(name: string, contents: string): string {
		const file = path.join(root, `${name}.inker`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, contents);
		return file;
	}

	it("resolves a component under components/<name>.inker", async () => {
		write("page", "{% component 'card' { title: page.title } %}");
		write("components/card", "[{{ title }}]");
		const templates = new Templates({ root, cacheMode: "mtime" });
		expect(await templates.render("page", { page: { title: "Hi" } })).toBe(
			"[Hi]",
		);
	});

	it("isolates component scope — parent data NOT visible (D7)", async () => {
		write("page", "{% component 'card' {} %}");
		write("components/card", "[{{ user.name }}]");
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", { user: { name: "Alice" } });
			expect.fail("should have thrown");
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe(
				"E_INKER_UNKNOWN_IDENTIFIER",
			);
		}
	});

	it("detects component circular includes (card → card)", async () => {
		write("page", "{% component 'card' {} %}");
		write("components/card", "{% component 'card' {} %}");
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", {});
			expect.fail();
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_CIRCULAR_INCLUDE");
		}
	});

	it("rejects components containing {% layout %}", async () => {
		write("page", "{% component 'bad' {} %}");
		write("components/bad", "{% layout 'main' %}\nx");
		write("main", "{{> body }}");
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", {});
			expect.fail();
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_LAYOUT_IN_PARTIAL");
		}
	});

	it("rejects components containing {{> body }} slot", async () => {
		write("page", "{% component 'bad' {} %}");
		write("components/bad", "[{{> body }}]");
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", {});
			expect.fail();
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_UNKNOWN_SLOT");
		}
	});

	it("rejects path-traversal in component name at parse time", async () => {
		write("page", "{% component '../etc/passwd' {} %}");
		const templates = new Templates({ root, cacheMode: "mtime" });
		try {
			await templates.render("page", {});
			expect.fail();
		} catch (e) {
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_PARSE_ERROR");
		}
	});

	it("renders a component nested in a partial", async () => {
		write("page", "{% include 'partials/widget' %}");
		write("partials/widget", "W[{% component 'card' { name: page.name } %}]");
		write("components/card", "<{{ name }}>");
		const templates = new Templates({ root, cacheMode: "mtime" });
		expect(await templates.render("page", { page: { name: "Bob" } })).toBe(
			"W[<Bob>]",
		);
	});

	it("component cache hits use mtime — re-renders after bumpMtime", async () => {
		const file = write("components/card", "[{{ title }}]");
		write("page", "{% component 'card' { title: page.title } %}");
		const templates = new Templates({ root, cacheMode: "mtime" });
		expect(await templates.render("page", { page: { title: "v1" } })).toBe(
			"[v1]",
		);

		fs.writeFileSync(file, "<{{ title }}>");
		bumpMtime(file, 10);
		expect(await templates.render("page", { page: { title: "v2" } })).toBe(
			"<v2>",
		);
	});

	it("renders a component inside an each loop with per-iter data scope", async () => {
		write(
			"page",
			"{% each users as user %}{% component 'card' { name: user.name } %}{% endeach %}",
		);
		write("components/card", "[{{ name }}]");
		const templates = new Templates({ root, cacheMode: "mtime" });
		expect(
			await templates.render("page", {
				users: [{ name: "A" }, { name: "B" }],
			}),
		).toBe("[A][B]");
	});
});
