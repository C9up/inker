/**
 * Verifies the published tarball shape for @c9up/inker.
 *
 * Adapted from packages/ream-mcp/tests/integration/published-shape.test.ts.
 * Differences from the reference:
 *   - No `bin` entries — inker is a library, not a CLI.
 *   - Different export shape:
 *       `.`                         — `browser` + `import` + `types`
 *       `./provider`                — `import` + `types`
 *       `./services/main`           — `import` + `types`
 *       `./testing`                 — `import` + `types`
 *   - No `dist/` build precondition — inker is source-first per ADR-003;
 *     the tarball ships `src/*.ts` and the consumer's loader compiles
 *     them at import time (verified by the standalone smoke). The
 *     `browser` condition file at `./dist/index.js` is a publish-time
 *     (maintainer) concern handled outside this test.
 *   - Asserts `README.md` and `LICENSE` are inside the tarball (AC5).
 *
 * Story 53.6 AC5.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type ExportEntry = {
	browser?: string;
	import: string;
	types: string;
};

type PackJson = {
	exports: Record<string, ExportEntry>;
};

function isExportEntry(value: unknown): value is ExportEntry {
	if (value === null || typeof value !== "object") return false;
	if (!("import" in value) || !("types" in value)) return false;
	const importVal: unknown = Reflect.get(value, "import");
	const typesVal: unknown = Reflect.get(value, "types");
	if (typeof importVal !== "string" || typeof typesVal !== "string") {
		return false;
	}
	if ("browser" in value) {
		const browserVal: unknown = Reflect.get(value, "browser");
		if (typeof browserVal !== "string") return false;
	}
	return true;
}

function isExportsMap(value: unknown): value is Record<string, ExportEntry> {
	if (value === null || typeof value !== "object") return false;
	for (const key of Object.keys(value)) {
		const entry: unknown = Reflect.get(value, key);
		if (!isExportEntry(entry)) return false;
	}
	return true;
}

function isPackJson(value: unknown): value is PackJson {
	if (value === null || typeof value !== "object") return false;
	if (!("exports" in value)) return false;
	return isExportsMap(value.exports);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..", "..");

describe("@c9up/inker published shape (AC5)", () => {
	let tmpDir = "";
	let tarballPath = "";

	beforeAll(() => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "inker-pack-"));
		const isWin = process.platform === "win32";
		const stdout = execFileSync(
			isWin ? "pnpm.cmd" : "pnpm",
			["pack", "--pack-destination", tmpDir],
			// `.cmd` needs a shell since the CVE-2024-27980 fix (EINVAL otherwise).
			{ cwd: PKG_ROOT, encoding: "utf8", shell: isWin },
		);
		const lastLine = stdout
			.trim()
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.pop();
		if (lastLine?.endsWith(".tgz") && existsSync(lastLine)) {
			tarballPath = lastLine;
		} else {
			throw new Error(
				`pnpm pack did not produce a discoverable tarball; stdout was:\n${stdout}`,
			);
		}
		// `pnpm pack` builds and archives the package: it is a minute's work on a
		// loaded machine, and it inherits the suite's per-test timeout, which is
		// sized for tests rather than for a build. The hook failed under load and
		// passed when run alone — a timeout that says what it is waiting for is
		// better than one that happens to be long enough.
	}, 180_000);

	afterAll(() => {
		if (tmpDir !== "") rmSync(tmpDir, { recursive: true, force: true });
	});

	it("ships every advertised export sub-path + README + LICENSE inside the tarball", () => {
		const pkgJsonRaw = execFileSync(
			"tar",
			["-xzOf", tarballPath, "package/package.json"],
			{ encoding: "utf8" },
		);
		const parsed: unknown = JSON.parse(pkgJsonRaw);
		if (!isPackJson(parsed)) {
			throw new Error("tarball package.json shape unexpected");
		}

		// AC5a — every sub-path declared
		expect(Object.keys(parsed.exports).sort()).toEqual([
			".",
			"./provider",
			"./services/main",
			"./testing",
		]);

		const tarList = execFileSync("tar", ["-tzf", tarballPath], {
			encoding: "utf8",
		})
			.split("\n")
			.filter(Boolean);
		const inTarball = new Set(tarList);

		// AC5b — every advertised `import` + `types` target lands in the tarball.
		// AC5 wording is explicit about import+types (source-first per ADR-003).
		// The `browser` condition on `.` points at the bundler-friendly `dist/`
		// output, which only materialises after `pnpm build`. Asserting its
		// presence here would force a build precondition (forbidden by story
		// T4.2 — inker ships TS source).
		for (const entry of Object.values(parsed.exports)) {
			const importTarget = `package/${entry.import.replace(/^\.\//, "")}`;
			const typesTarget = `package/${entry.types.replace(/^\.\//, "")}`;
			expect(inTarball.has(importTarget), importTarget).toBe(true);
			expect(inTarball.has(typesTarget), typesTarget).toBe(true);
		}

		// AC5c — README + LICENSE present (package.json `files` advertises them)
		expect(inTarball.has("package/README.md")).toBe(true);
		expect(inTarball.has("package/LICENSE")).toBe(true);
	});
});
