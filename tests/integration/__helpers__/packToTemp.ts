/**
 * Pack the package the way a publish would, without writing into the
 * repository.
 *
 * A plain `pnpm pack` runs the `prepack` build, which emits into `<package>/dist`
 * — every test run rewrote the developer's build output in place. Here the same
 * build is pointed at a staging copy of the package under the caller's temp
 * directory, and that copy is packed instead.
 */

import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);

const BUILD_SCRIPT = "tsc -p tsconfig.build.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build, stage and pack the package into `tmpDir`; returns the tarball path. */
export function packToTemp(tmpDir: string): string {
	const manifest: unknown = JSON.parse(
		readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"),
	);
	if (!isRecord(manifest) || !isRecord(manifest.scripts)) {
		throw new Error("package.json has no scripts");
	}
	// The staged build stands in for `prepack`: if that script ever stops being
	// this exact build, the stand-in no longer proves anything.
	if (manifest.scripts.prepack !== BUILD_SCRIPT) {
		throw new Error(
			`prepack is ${JSON.stringify(manifest.scripts.prepack)}, expected ${JSON.stringify(BUILD_SCRIPT)}`,
		);
	}

	const stage = path.join(tmpDir, "stage");
	mkdirSync(stage, { recursive: true });
	const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
	execFileSync(
		process.execPath,
		[tsc, "-p", "tsconfig.build.json", "--outDir", path.join(stage, "dist")],
		{ cwd: PKG_ROOT, encoding: "utf8" },
	);
	for (const file of readdirSync(PKG_ROOT)) {
		if (
			file === "README.md" ||
			file === "LICENSE" ||
			/^index\..+\.node$/.test(file)
		) {
			copyFileSync(path.join(PKG_ROOT, file), path.join(stage, file));
		}
	}
	// The build already ran; the staged copy has no sources to run it on.
	const scripts = Object.fromEntries(
		Object.entries(manifest.scripts).filter(([name]) => name !== "prepack"),
	);
	writeFileSync(
		path.join(stage, "package.json"),
		`${JSON.stringify({ ...manifest, scripts }, null, 2)}\n`,
	);

	const isWin = process.platform === "win32";
	const stdout = execFileSync(
		isWin ? "pnpm.cmd" : "pnpm",
		["pack", "--pack-destination", tmpDir],
		// `.cmd` needs a shell since the CVE-2024-27980 fix (EINVAL otherwise).
		{ cwd: stage, encoding: "utf8", shell: isWin },
	);
	const tarball = readdirSync(tmpDir).find((f) => f.endsWith(".tgz"));
	if (tarball === undefined || !existsSync(path.join(tmpDir, tarball))) {
		throw new Error(
			`pnpm pack did not produce a tarball in ${tmpDir}; stdout was:\n${stdout}`,
		);
	}
	return path.join(tmpDir, tarball);
}
