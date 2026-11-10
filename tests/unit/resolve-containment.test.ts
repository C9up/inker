import fsModule, * as fs from "node:fs";
import fsPromisesModule from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { getNative } from "../../src/loadNapi.js";
import { Templates } from "../../src/Templates.js";

// `resolve()` reads a template's source, so it must stop at the templates
// root exactly as `render()` does — through symlinks too.

function setup(): { views: string; secret: string } {
	const base = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-resolve-")),
	);
	const views = path.join(base, "views");
	const secret = path.join(base, "secret");
	fs.mkdirSync(views);
	fs.mkdirSync(secret);
	fs.writeFileSync(path.join(secret, "leak.inker"), "SECRET");
	fs.writeFileSync(path.join(views, "ok.inker"), "fine");
	fs.mkdirSync(path.join(views, "folder.inker"));
	fs.symlinkSync(secret, path.join(views, "linked"));
	fs.symlinkSync(
		path.join(secret, "leak.inker"),
		path.join(views, "direct.inker"),
	);
	return { views, secret };
}

function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof InkerRenderError) return e.code;
		throw e;
	}
	throw new Error("expected an InkerRenderError");
}

describe("Templates#resolve containment", () => {
	it("refuses a template reached through a symlinked directory", () => {
		const t = new Templates({ root: setup().views });
		expect(codeOf(() => t.resolve("linked/leak"))).toBe("E_INKER_INVALID_PATH");
	});

	it("refuses a symlinked final segment", () => {
		const t = new Templates({ root: setup().views });
		expect(codeOf(() => t.resolve("direct"))).toBe("E_INKER_INVALID_PATH");
	});

	it("reports a directory as an invalid path, not as missing", () => {
		const t = new Templates({ root: setup().views });
		expect(codeOf(() => t.resolve("folder"))).toBe("E_INKER_INVALID_PATH");
	});

	it("still reads a normal file, reports a missing one, and serves memory", () => {
		const t = new Templates({ root: setup().views });
		expect(t.resolve("ok")).toEqual({ template: "fine" });
		expect(codeOf(() => t.resolve("nope"))).toBe("E_INKER_TEMPLATE_NOT_FOUND");
		t.registerTemplate("mem", { template: "from memory" });
		expect(t.resolve("mem")).toEqual({ template: "from memory" });
	});
});

/**
 * The race the containment check must survive: a directory symlink inside the
 * root points OUTSIDE when the file is opened, then is swapped to point INSIDE
 * before the check runs. A check that re-resolves the path sees the inside
 * file and passes, while the read uses the outside one already opened.
 *
 * The swap is forced deterministically by wrapping the open call (patched on
 * the builtin module, then synced into its ESM exports).
 */
describe("containment is bound to the opened file", () => {
	function swapSetup(): { views: string; link: string; safe: string } {
		const { views, secret } = setup();
		const safe = path.join(views, "safe");
		fs.mkdirSync(safe);
		fs.writeFileSync(path.join(safe, "leak.inker"), "SAFE");
		const link = path.join(views, "swap");
		fs.symlinkSync(secret, link);
		return { views, link, safe };
	}

	function swapLink(link: string, target: string): void {
		fs.unlinkSync(link);
		fs.symlinkSync(target, link);
	}

	/** Run `body` with `name` on `holder` wrapped to call `after` once it returned. */
	async function patched<T>(
		holder: object,
		name: string,
		after: () => void,
		body: () => T | Promise<T>,
	): Promise<T> {
		const original: unknown = Reflect.get(holder, name);
		if (typeof original !== "function") throw new Error(`${name} missing`);
		let swapped = false;
		Reflect.set(holder, name, (...args: unknown[]) => {
			const result: unknown = Reflect.apply(original, holder, args);
			const finish = () => {
				if (!swapped) {
					swapped = true;
					after();
				}
			};
			if (result instanceof Promise) {
				return result.then((value: unknown) => {
					finish();
					return value;
				});
			}
			finish();
			return result;
		});
		syncBuiltinESMExports();
		try {
			const out = await body();
			expect(swapped).toBe(true);
			return out;
		} finally {
			Reflect.set(holder, name, original);
			syncBuiltinESMExports();
		}
	}

	async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
		try {
			await fn();
		} catch (e) {
			if (e instanceof InkerRenderError) return e.code;
			throw e;
		}
		throw new Error("expected an InkerRenderError");
	}

	it("refuses resolve() when the directory is swapped after the open", async () => {
		const { views, link, safe } = swapSetup();
		const t = new Templates({ root: views, cacheMode: "never" });
		const code = await patched(
			fsModule,
			"openSync",
			() => swapLink(link, safe),
			() => codeOf(() => t.resolve("swap/leak")),
		);
		expect(code).toBe("E_INKER_INVALID_PATH");
	});

	it("refuses renderSync() when the directory is swapped after the open", async () => {
		const { views, link, safe } = swapSetup();
		const t = new Templates({ root: views, cacheMode: "never" });
		const code = await patched(
			fsModule,
			"openSync",
			() => swapLink(link, safe),
			() => codeOf(() => t.renderSync("swap/leak")),
		);
		expect(code).toBe("E_INKER_INVALID_PATH");
	});

	it("refuses render() when the directory is swapped after the open", async () => {
		const { views, link, safe } = swapSetup();
		const t = new Templates({ root: views, cacheMode: "never" });
		const code = await patched(
			fsPromisesModule,
			"open",
			() => swapLink(link, safe),
			() => codeOfAsync(() => t.render("swap/leak")),
		);
		expect(code).toBe("E_INKER_INVALID_PATH");
	});

	it("refuses the swap without /proc too, by comparing the opened inode", async () => {
		const { views, link, safe } = swapSetup();
		const t = new Templates({ root: views, cacheMode: "never" });
		const readlink: unknown = Reflect.get(fsModule, "readlinkSync");
		if (typeof readlink !== "function") throw new Error("readlinkSync missing");
		Reflect.set(fsModule, "readlinkSync", (...args: unknown[]) => {
			if (String(args[0]).startsWith("/proc/self/fd/")) {
				throw Object.assign(new Error("no /proc"), { code: "ENOENT" });
			}
			return Reflect.apply(readlink, fsModule, args);
		});
		syncBuiltinESMExports();
		try {
			const code = await patched(
				fsModule,
				"openSync",
				() => swapLink(link, safe),
				() => codeOf(() => t.resolve("swap/leak")),
			);
			expect(code).toBe("E_INKER_INVALID_PATH");
			// Without a swap the fallback still reads a file inside the root.
			expect(t.resolve("safe/leak")).toEqual({ template: "SAFE" });
		} finally {
			Reflect.set(fsModule, "readlinkSync", readlink);
			syncBuiltinESMExports();
		}
	});

	/**
	 * The second swap a path-then-inode check cannot see: the link points
	 * OUTSIDE at the open, INSIDE while the path is resolved, and the inside
	 * directory it named is then replaced by a link OUTSIDE before its inode is
	 * compared — so the checked path is inside and the compared inode is the
	 * opened, outside one. Only a check asked of the descriptor refuses it:
	 * procfs on Linux, the engine on macOS and Windows.
	 */
	it("refuses a second swap between resolving the path and comparing inodes", async () => {
		const { views, link, safe } = swapSetup();
		const secret = path.join(path.dirname(views), "secret");
		const t = new Templates({ root: views, cacheMode: "never" });
		const realpath = fsModule.realpathSync;
		const nativeRealpath = realpath.native;
		let resolvedThenSwapped = false;
		Reflect.set(realpath, "native", (...args: unknown[]) => {
			const out: unknown = Reflect.apply(nativeRealpath, realpath, args);
			if (!resolvedThenSwapped && String(out).endsWith("leak.inker")) {
				resolvedThenSwapped = true;
				fs.renameSync(safe, `${safe}-before`);
				fs.symlinkSync(secret, safe);
			}
			return out;
		});
		try {
			const code = await patched(
				fsModule,
				"openSync",
				() => swapLink(link, safe),
				() => codeOf(() => t.resolve("swap/leak")),
			);
			expect(code).toBe("E_INKER_INVALID_PATH");
			if (
				process.platform === "linux" ||
				process.platform === "darwin" ||
				process.platform === "win32"
			) {
				// Asked of the descriptor: the path is never resolved again.
				expect(resolvedThenSwapped).toBe(false);
			}
		} finally {
			Reflect.set(realpath, "native", nativeRealpath);
		}
	});

	it("names an open file by its descriptor where the engine can ask", () => {
		// What the check relies on without procfs: where the opened file is
		// NOW, not where it was opened from.
		const { views } = setup();
		const fd = fs.openSync(path.join(views, "ok.inker"), "r");
		try {
			fs.renameSync(
				path.join(views, "ok.inker"),
				path.join(views, "moved.inker"),
			);
			const located = getNative().openedPath(fd);
			if (process.platform === "darwin" || process.platform === "win32") {
				expect(located).toBe(
					fs.realpathSync.native(path.join(views, "moved.inker")),
				);
			} else {
				// Linux is asked through procfs by Templates itself.
				expect(located).toBeNull();
			}
		} finally {
			fs.closeSync(fd);
		}
	});

	it("reads the inside file when the link points inside all along", async () => {
		const { views, link, safe } = swapSetup();
		swapLink(link, safe);
		const t = new Templates({ root: views, cacheMode: "never" });
		expect(t.resolve("swap/leak")).toEqual({ template: "SAFE" });
		expect(await t.render("swap/leak")).toBe("SAFE");
	});
});
