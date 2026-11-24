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
import { nativeBinarySuffix } from "../../../src/vendor/nativeBinary.js";

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
	// The binary is not in here: it ships in the platform package
	// (`packPlatformToTemp`).
	for (const file of ["README.md", "LICENSE"]) {
		copyFileSync(path.join(PKG_ROOT, file), path.join(stage, file));
	}
	// The build already ran; the staged copy has no sources to run it on.
	const scripts = Object.fromEntries(
		Object.entries(manifest.scripts).filter(([name]) => name !== "prepack"),
	);
	writeFileSync(
		path.join(stage, "package.json"),
		`${JSON.stringify({ ...manifest, scripts }, null, 2)}\n`,
	);

	return pack(stage, path.join(tmpDir, "packed"));
}

/**
 * Pack this host's platform package (`npm/<suffix>/`) into `tmpDir`, as the
 * publish job does: its manifest, the binary built at the package root, and
 * the licence. Returns the platform package's name and the tarball path.
 */
export function packPlatformToTemp(tmpDir: string): {
	name: string;
	tarball: string;
} {
	const suffix = nativeBinarySuffix();
	if (suffix === undefined) {
		throw new Error(`no platform package is built for ${process.platform}`);
	}
	const binary = `index.${suffix}.node`;
	if (!existsSync(path.join(PKG_ROOT, binary))) {
		throw new Error(`${binary} is not built: run pnpm build:napi first`);
	}
	const stage = path.join(tmpDir, "stage-platform");
	mkdirSync(stage, { recursive: true });
	copyFileSync(path.join(PKG_ROOT, binary), path.join(stage, binary));
	copyFileSync(path.join(PKG_ROOT, "LICENSE"), path.join(stage, "LICENSE"));
	copyFileSync(
		path.join(PKG_ROOT, "npm", suffix, "package.json"),
		path.join(stage, "package.json"),
	);
	return {
		name: `@c9up/inker-${suffix}`,
		tarball: pack(stage, path.join(tmpDir, "packed-platform")),
	};
}

/** `pnpm pack` the staged `dir` into the new directory `into`; the tarball's path. */
function pack(dir: string, into: string): string {
	mkdirSync(into, { recursive: true });
	const isWin = process.platform === "win32";
	const stdout = execFileSync(
		isWin ? "pnpm.cmd" : "pnpm",
		["pack", "--pack-destination", into],
		// `.cmd` needs a shell since the CVE-2024-27980 fix (EINVAL otherwise).
		{ cwd: dir, encoding: "utf8", shell: isWin },
	);
	const tarball = readdirSync(into).find((f) => f.endsWith(".tgz"));
	if (tarball === undefined) {
		throw new Error(
			`pnpm pack did not produce a tarball in ${into}; stdout was:\n${stdout}`,
		);
	}
	return path.join(into, tarball);
}
