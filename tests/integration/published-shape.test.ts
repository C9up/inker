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
 *   - The tarball is the one a publish would produce: the build runs into a
 *     staging copy under the temp dir (see `packToTemp`), never into the
 *     repository's own `dist/`.
 *   - Asserts `README.md` and `LICENSE` are inside the tarball (AC5).
 *
 * Story 53.6 AC5.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG_ROOT, packToTemp } from "./__helpers__/packToTemp.js";

/** Every file under the package's own `dist/` with its mtime, or null. */
function distSnapshot(): string[] | null {
	const dist = path.join(PKG_ROOT, "dist");
	if (!existsSync(dist)) return null;
	return readdirSync(dist, { recursive: true, encoding: "utf8" })
		.sort()
		.map((file) => `${file}@${statSync(path.join(dist, file)).mtimeMs}`);
}

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

describe("@c9up/inker published shape (AC5)", () => {
	let tmpDir = "";
	let tarballPath = "";
	let distBefore: string[] | null = null;

	beforeAll(() => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "inker-pack-"));
		distBefore = distSnapshot();
		tarballPath = packToTemp(tmpDir);
		// `pnpm pack` builds and archives the package: it is a minute's work on a
		// loaded machine, and it inherits the suite's per-test timeout, which is
		// sized for tests rather than for a build. The hook failed under load and
		// passed when run alone — a timeout that says what it is waiting for is
		// better than one that happens to be long enough.
	}, 180_000);

	afterAll(() => {
		if (tmpDir !== "") rmSync(tmpDir, { recursive: true, force: true });
	});

	it("packs without writing into the package's own dist/", () => {
		expect(distSnapshot()).toEqual(distBefore);
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
