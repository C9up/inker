/**
 * Named-disk mount + `namespace::template` resolution — AdonisJS/Edge
 * `edge.mount(name, dir)` parity (Story 57.1).
 *
 * A package that ships its own templates mounts its directory as a named
 * disk and addresses its templates as `name::template`; a BARE name always
 * resolves against the default (constructor) root, exactly like Edge.
 * Containment (path-shape validation + the symlink guard) is enforced
 * against the DISK's own root, so mounting a second directory cannot widen
 * traversal out of either root.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";
import { asTyped } from "../__helpers__/bypass-type-check.js";

function makeTempRoot(prefix: string): string {
	return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(root: string, rel: string, source: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, source, "utf8");
}

describe("Templates — named disks (edge.mount parity)", () => {
	let defaultRoot: string;
	let pkgRoot: string;

	beforeEach(() => {
		defaultRoot = makeTempRoot("inker-default-");
		pkgRoot = makeTempRoot("inker-pkg-");
		write(defaultRoot, "home.inker", "<p>default home</p>");
		write(pkgRoot, "hello.inker", "<p>pkg hello {{ name }}</p>");
		write(pkgRoot, "layout.inker", "<html><body>{{> body }}</body></html>");
		write(pkgRoot, "page.inker", "@layout('pkg::layout')<main>pkg page</main>");
	});

	afterEach(() => {
		fs.rmSync(defaultRoot, { recursive: true, force: true });
		fs.rmSync(pkgRoot, { recursive: true, force: true });
	});

	it("resolves `disk::template` against the mounted disk root", async () => {
		const t = new Templates({ root: defaultRoot, cacheMode: "never" });
		t.mount("pkg", pkgRoot);
		const html = await t.render("pkg::hello", { name: "Ada" });
		expect(html).toBe("<p>pkg hello Ada</p>");
	});

	it("auto-escapes data in a disk-mounted template (no XSS leak across disks)", async () => {
		const t = new Templates({ root: defaultRoot, cacheMode: "never" });
		t.mount("pkg", pkgRoot);
		const html = await t.render("pkg::hello", { name: "<script>x</script>" });
		expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
		expect(html).not.toContain("<script>x</script>");
	});

	it("resolves a `disk::layout` reference within the same disk", async () => {
		const t = new Templates({ root: defaultRoot, cacheMode: "never" });
		t.mount("pkg", pkgRoot);
		const html = await t.render("pkg::page", {});
		expect(html).toBe("<html><body><main>pkg page</main></body></html>");
	});

	it("resolves a cross-disk `disk::layout` from a default-root template", async () => {
		write(
			defaultRoot,
			"child.inker",
			"@layout('pkg::layout')<main>default child</main>",
		);
		const t = new Templates({ root: defaultRoot, cacheMode: "never" });
		t.mount("pkg", pkgRoot);
		const html = await t.render("child", {});
		expect(html).toBe("<html><body><main>default child</main></body></html>");
	});

	it("a BARE name resolves the default root, never a mounted disk", async () => {
		const t = new Templates({ root: defaultRoot, cacheMode: "never" });
		t.mount("pkg", pkgRoot);
		// `home` exists only in the default root; `hello` only in the pkg disk.
		expect(await t.render("home", {})).toBe("<p>default home</p>");
		// A bare `hello` must NOT reach the pkg disk → template-not-found.
		await expect(t.render("hello", {})).rejects.toMatchObject({
			code: "E_INKER_TEMPLATE_NOT_FOUND",
		});
	});

	it("rejects an unknown disk with E_INKER_INVALID_PATH", async () => {
		const t = new Templates({ root: defaultRoot, cacheMode: "never" });
		try {
			await t.render("nope::hello", {});
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(InkerRenderError);
			expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
			expect(asTyped<InkerRenderError>(e).message).toContain(
				"Unknown templates disk 'nope'",
			);
		}
	});

	it("unmount() removes a disk — later `disk::` renders throw unknown-disk", async () => {
		const t = new Templates({ root: defaultRoot, cacheMode: "never" });
		t.mount("pkg", pkgRoot);
		expect(await t.render("pkg::hello", { name: "x" })).toBe(
			"<p>pkg hello x</p>",
		);
		t.unmount("pkg");
		await expect(t.render("pkg::hello", { name: "x" })).rejects.toMatchObject({
			code: "E_INKER_INVALID_PATH",
		});
	});

	it("re-mounting a name to a different root throws E_INKER_DISK_COLLISION (unmount to replace)", async () => {
		const other = makeTempRoot("inker-other-");
		write(other, "hello.inker", "<p>other hello</p>");
		try {
			const t = new Templates({ root: defaultRoot, cacheMode: "never" });
			t.mount("pkg", pkgRoot);
			expect(await t.render("pkg::hello", { name: "x" })).toBe(
				"<p>pkg hello x</p>",
			);
			// Accidental clash to a different directory fails loud, not silent clobber.
			try {
				t.mount("pkg", other);
				expect.unreachable(
					"mounting a taken disk name to a new root must throw",
				);
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe(
					"E_INKER_DISK_COLLISION",
				);
			}
			// The rejected mount left the original disk untouched.
			expect(await t.render("pkg::hello", { name: "x" })).toBe(
				"<p>pkg hello x</p>",
			);
			// Re-mounting the SAME root is an idempotent no-op.
			t.mount("pkg", pkgRoot);
			expect(await t.render("pkg::hello", { name: "x" })).toBe(
				"<p>pkg hello x</p>",
			);
			// Intentional replacement stays possible — explicit unmount, then mount.
			t.unmount("pkg");
			t.mount("pkg", other);
			expect(await t.render("pkg::hello", {})).toBe("<p>other hello</p>");
		} finally {
			fs.rmSync(other, { recursive: true, force: true });
		}
	});

	it("containment holds per-disk — `disk::..` traversal is rejected", async () => {
		const t = new Templates({ root: defaultRoot, cacheMode: "never" });
		t.mount("pkg", pkgRoot);
		await expect(t.render("pkg::../secret", {})).rejects.toMatchObject({
			code: "E_INKER_INVALID_PATH",
		});
	});

	it("rejects invalid disk names (path-shaped / separator / empty)", () => {
		const t = new Templates({ root: defaultRoot, cacheMode: "never" });
		for (const bad of ["a/b", "a::b", "", "a b", "../x"]) {
			expect(() => t.mount(bad, pkgRoot)).toThrowError(InkerRenderError);
		}
	});
});
