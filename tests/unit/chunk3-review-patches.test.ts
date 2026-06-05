import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { type HelperFn, Templates } from "../../src/index.js";
import { asTyped, bypassTypeCheck } from "../__helpers__/bypass-type-check.js";

function makeTempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "inker-chunk3-"));
}

function write(root: string, rel: string, content: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

describe("chunk3 review patches", () => {
	let root: string;
	beforeEach(() => {
		root = makeTempRoot();
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	// T2 — normalizePartialKey rejects empty key.
	// Note: most degenerate forms (`./`, `foo//bar`, etc.) are caught earlier
	// by chunk1 P8/P9's validatePathName (which throws E_INKER_PARSE_ERROR).
	// T2 hardens normalizePartialKey defensively for direct-AST callers, so
	// the parser-error path is also acceptable.
	describe("T2 — normalizePartialKey defense-in-depth (parser already rejects)", () => {
		it("`{% include './' %}` is rejected (by parser OR by normalizer)", async () => {
			write(root, "index.inker", "{% include './' %}");
			const tpl = new Templates({ root });
			try {
				await tpl.render("index", {});
				expect.fail("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(InkerRenderError);
				const code = asTyped<InkerRenderError>(e).code;
				// Either path is acceptable: chunk1-P9 catches `.` segments at
				// parse time; T2 catches the post-normalizer empty key.
				expect(["E_INKER_PARSE_ERROR", "E_INKER_INVALID_PATH"]).toContain(code);
			}
		});
	});

	// T3 — Helper Map key must be a string
	describe("T3 — helper Map key must be a string", () => {
		it("throws InkerRenderError (not raw TypeError) for Symbol key", () => {
			const helpers = new Map<unknown, HelperFn>([[Symbol("bad"), () => "x"]]);
			try {
				new Templates({
					root,
					helpers: bypassTypeCheck<ReadonlyMap<string, HelperFn>>(helpers),
				});
				expect.fail("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(InkerRenderError);
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
				expect(asTyped<InkerRenderError>(e).message).toMatch(
					/must be a string/,
				);
			}
		});

		it("throws InkerRenderError for number key", () => {
			const helpers = new Map<unknown, HelperFn>([[42, () => "x"]]);
			try {
				new Templates({
					root,
					helpers: bypassTypeCheck<ReadonlyMap<string, HelperFn>>(helpers),
				});
				expect.fail("should have thrown");
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
			}
		});
	});

	// T4 — BOM strip in both disk-load and renderString paths
	describe("T4 — BOM is stripped from source", () => {
		it("BOM-prefixed template still parses `{% layout %}` as layout", async () => {
			write(root, "layouts/main.inker", "<html>{{> body }}</html>");
			write(root, "page.inker", "﻿{% layout 'layouts/main' %}HELLO");
			const tpl = new Templates({ root });
			const html = await tpl.render("page", {});
			expect(html).toBe("<html>HELLO</html>");
		});

		it("renderString strips BOM too", () => {
			const tpl = new Templates({ root });
			expect(tpl.renderString("﻿hello {{ name }}", { name: "world" })).toBe(
				"hello world",
			);
		});
	});

	// T5 — duplicate `{% layout %}` in body throws
	describe("T5 — duplicate layout in body is rejected", () => {
		it("throws E_INKER_DUPLICATE_LAYOUT for a second `{% layout %}`", async () => {
			write(root, "layouts/a.inker", "<a>{{> body }}</a>");
			write(root, "layouts/b.inker", "<b>{{> body }}</b>");
			write(
				root,
				"page.inker",
				"{% layout 'layouts/a' %}body{% layout 'layouts/b' %}",
			);
			const tpl = new Templates({ root });
			try {
				await tpl.render("page", {});
				expect.fail("should have thrown");
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe(
					"E_INKER_DUPLICATE_LAYOUT",
				);
			}
		});

		it("a single layout still works", async () => {
			write(root, "layouts/a.inker", "<a>{{> body }}</a>");
			write(root, "page.inker", "{% layout 'layouts/a' %}body");
			const tpl = new Templates({ root });
			expect(await tpl.render("page", {})).toBe("<a>body</a>");
		});
	});

	// T6 — realpath BEFORE readFile (memory exposure mitigation)
	describe("T6 — symlink containment runs before readFile", () => {
		it("rejects a symlink to outside-root WITHOUT exposing the content", async () => {
			// Create a sensitive file outside root that the symlink would expose.
			const sensitiveDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "inker-secret-"),
			);
			try {
				const secretPath = path.join(sensitiveDir, "secret.txt");
				fs.writeFileSync(secretPath, "PASSWORD=supersecret\n");
				fs.symlinkSync(secretPath, path.join(root, "evil.inker"));

				const tpl = new Templates({ root });
				try {
					await tpl.render("evil", {});
					expect.fail("should have thrown");
				} catch (e) {
					expect(e).toBeInstanceOf(InkerRenderError);
					expect(asTyped<InkerRenderError>(e).code).toBe(
						"E_INKER_INVALID_PATH",
					);
					// P1: post-O_NOFOLLOW the symlink final segment is refused at
					// `open()` time with ELOOP rather than read-then-realpath-check.
					// Either message variant proves the content was never read —
					// the security property (no exposure) is asserted by the
					// `not.toContain("PASSWORD")` check below, which is the real
					// regression guard.
					expect(asTyped<InkerRenderError>(e).message).toMatch(
						/escapes the templates root via symlink|not a readable file \(ELOOP\)/,
					);
					// The error message must not leak the secret content. (Direct
					// check that the message doesn't contain the secret.)
					expect(asTyped<InkerRenderError>(e).message).not.toContain(
						"PASSWORD",
					);
				}
			} finally {
				fs.rmSync(sensitiveDir, { recursive: true, force: true });
			}
		});
	});

	// T7 — clearCache also drops in-flight + generation guard
	describe("T7 — clearCache invalidates the cache", () => {
		it("re-reads after clearCache in 'never' mode (otherwise cached forever)", async () => {
			write(root, "p.inker", "v1");
			const tpl = new Templates({ root, cacheMode: "never" });
			expect(await tpl.render("p", {})).toBe("v1");
			// "never" mode normally never re-reads; clearCache is the only way
			// to force a re-read.
			fs.writeFileSync(path.join(root, "p.inker"), "v2");
			expect(await tpl.render("p", {})).toBe("v1"); // still cached
			tpl.clearCache();
			expect(await tpl.render("p", {})).toBe("v2"); // forced re-read
		});

		it("a load completing AFTER clearCache does NOT silently restore the stale AST", async () => {
			// Generation-guard test: start a render (which kicks off a load
			// promise), call clearCache before the promise resolves, then
			// verify the next render fetches fresh content.
			write(root, "p.inker", "v1");
			const tpl = new Templates({ root, cacheMode: "mtime" });
			const inflight = tpl.render("p", {}); // starts the load
			tpl.clearCache(); // bumps generation
			await inflight; // resolves to "v1" but generation-guard skips cache.set
			// Bump mtime so the next render sees the fresh content.
			fs.writeFileSync(path.join(root, "p.inker"), "v2");
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(path.join(root, "p.inker"), future, future);
			expect(await tpl.render("p", {})).toBe("v2");
		});
	});

	// T8 — validateName rejects control chars / surrogates / BOM
	describe("T8 — validateName rejects control characters", () => {
		it("rejects newline in template name", async () => {
			const tpl = new Templates({ root });
			try {
				await tpl.render("foo\nbar", {});
				expect.fail("should have thrown");
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
				expect(asTyped<InkerRenderError>(e).message).toMatch(
					/control character/,
				);
			}
		});

		it("rejects tab in template name", async () => {
			const tpl = new Templates({ root });
			try {
				await tpl.render("foo\tbar", {});
				expect.fail("should have thrown");
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
			}
		});

		it("rejects ESC byte in template name (ANSI injection vector)", async () => {
			const tpl = new Templates({ root });
			try {
				await tpl.render("foo\x1bbar", {});
				expect.fail("should have thrown");
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
			}
		});

		it("rejects BOM in template name", async () => {
			const tpl = new Templates({ root });
			try {
				await tpl.render("﻿foo", {});
				expect.fail("should have thrown");
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
				expect(asTyped<InkerRenderError>(e).message).toMatch(/BOM/);
			}
		});

		it("rejects lone high surrogate in template name", async () => {
			const tpl = new Templates({ root });
			try {
				await tpl.render("foo\uD800bar", {});
				expect.fail("should have thrown");
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
				expect(asTyped<InkerRenderError>(e).message).toMatch(
					/lone high surrogate/,
				);
			}
		});

		it("rejects lone low surrogate in template name", async () => {
			const tpl = new Templates({ root });
			try {
				await tpl.render("foo\uDC00bar", {});
				expect.fail("should have thrown");
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
				expect(asTyped<InkerRenderError>(e).message).toMatch(
					/lone low surrogate/,
				);
			}
		});

		it("accepts valid paired surrogate (emoji)", async () => {
			// "😀" = 😀 — a valid surrogate pair (single codepoint).
			write(root, "page😀.inker", "ok");
			const tpl = new Templates({ root });
			expect(await tpl.render("page😀", {})).toBe("ok");
		});
	});

	// D3 — Constructor rejects filesystem-root
	describe("D3 — constructor rejects filesystem/drive root", () => {
		it("rejects root = '/'", () => {
			expect(() => new Templates({ root: "/" })).toThrow(InkerRenderError);
		});

		it("rejects Windows drive root like 'C:\\'", () => {
			// On POSIX this still hits the regex via the literal value.
			try {
				new Templates({ root: "C:\\" });
				expect.fail("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(InkerRenderError);
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_INVALID_PATH");
			}
		});

		it("accepts a nested absolute directory normally", () => {
			expect(() => new Templates({ root })).not.toThrow();
		});
	});

	// D1 — mtime=0 sentinel forces re-parse
	describe("D1 — mtime=0 sentinel forces re-parse", () => {
		it("never caches when mtimeMs is 0 (FUSE/tar sentinel)", async () => {
			write(root, "p.inker", "v1");
			// Force mtime to epoch-0 to simulate the sentinel.
			fs.utimesSync(path.join(root, "p.inker"), new Date(0), new Date(0));
			const tpl = new Templates({ root, cacheMode: "mtime" });
			expect(await tpl.render("p", {})).toBe("v1");
			// Overwrite without touching mtime (still 0).
			fs.writeFileSync(path.join(root, "p.inker"), "v2");
			fs.utimesSync(path.join(root, "p.inker"), new Date(0), new Date(0));
			// Pre-D1 would cache and return "v1"; D1 forces re-parse on the
			// mtime=0 sentinel and the new content is seen.
			expect(await tpl.render("p", {})).toBe("v2");
		});
	});

	// T10 — exhaustiveness in findFirstDiskNodeIn
	describe("T10 — findFirstDiskNodeIn exhaustiveness", () => {
		it("still detects a Partial node under nested If", () => {
			const tpl = new Templates({ root });
			try {
				tpl.renderString("{% if true %}{% include 'foo' %}{% endif %}", {});
				expect.fail("should have thrown");
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_DISK_REQUIRED");
			}
		});

		it("still detects a Component node under nested Each", () => {
			const tpl = new Templates({ root });
			try {
				tpl.renderString(
					"{% each xs as x %}{% component 'card' { x: x } %}{% endeach %}",
					{ xs: [1] },
				);
				expect.fail("should have thrown");
			} catch (e) {
				expect(asTyped<InkerRenderError>(e).code).toBe("E_INKER_DISK_REQUIRED");
			}
		});
	});
});
