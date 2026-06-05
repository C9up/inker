/**
 * Standalone smoke — proves @c9up/inker imports + renders without
 * @c9up/ream or @c9up/rosetta in the consumer's node_modules.
 *
 * Story 53.6 AC1, AC2, AC6.
 *
 * Strategy:
 *   1. `pnpm pack` the workspace inker package into a tmp tarball.
 *   2. Seed a fresh consumer dir (under /tmp) with @c9up/inker declared as
 *      `file:<tarball>` — no ream, no rosetta. devDeps add `tsx` so the
 *      consumer can `node --import tsx` runtime-TS sources (inker is
 *      source-first per ADR-003; its export-map points at `./src/*.ts`).
 *   3. `pnpm install --ignore-workspace --no-frozen-lockfile` inside the
 *      consumer (the --ignore-workspace flag is belt-and-suspenders; /tmp has
 *      no parent workspace, but the flag locks behaviour against a future
 *      $TMPDIR move into a workspace-rooted dir).
 *   4. Render a composite template (interpolation + layout + partial + if
 *      + each + helper) via a spawned `node --import tsx ...`.
 *   5. Import @c9up/inker/provider as the second `it()` block.
 *
 * Per cerebrum DNR feedback_local_dev_no_npm: @c9up/* is NOT on npm during
 * local dev — the fixture MUST install via `file:<tarball>`, never via
 * `pnpm add @c9up/inker` against the public registry.
 *
 * Why `tsx` and not `@swc-node/register`: Node 25's built-in TS stripping
 * refuses files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)
 * and the `@swc-node/register` ESM loader defers to it. `tsx` (used elsewhere
 * in this repo — see `packages/ream-mcp/tests/integration/server.test.ts`)
 * intercepts node_modules TS imports cleanly.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..", "..");

const SMOKE_TIMEOUT_MS = 180_000;

function readStreamField(err: unknown, key: "stdout" | "stderr"): string {
	if (err === null || typeof err !== "object") return "";
	const raw: unknown = Reflect.get(err, key);
	if (raw === undefined || raw === null) return "";
	return typeof raw === "string" ? raw : String(raw);
}

function runChild(file: string, args: readonly string[], cwd: string): string {
	try {
		return execFileSync(file, args, {
			cwd,
			encoding: "utf8",
			env: { ...process.env, CI: "1" },
			maxBuffer: 50 * 1024 * 1024,
		});
	} catch (err) {
		const stdout = readStreamField(err, "stdout");
		const stderr = readStreamField(err, "stderr");
		throw new Error(
			`${file} ${args.join(" ")} failed in ${cwd}\n` +
				`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
			{ cause: err instanceof Error ? err : undefined },
		);
	}
}

function runPnpm(args: readonly string[], cwd: string): string {
	return runChild("pnpm", args, cwd);
}

function tarballFromPackOutput(stdout: string, tmpDir: string): string {
	// `pnpm pack --pack-destination <dir>` prints the absolute tarball path
	// as the last non-empty line of stdout (see ream-mcp/.../published-shape).
	const lastLine = stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.pop();
	const resolvedTmp = path.resolve(tmpDir);
	if (
		lastLine?.endsWith(".tgz") &&
		existsSync(lastLine) &&
		path.resolve(lastLine).startsWith(`${resolvedTmp}${path.sep}`)
	) {
		return lastLine;
	}
	// Fallback: scan the dir for a .tgz (some pnpm versions print a footer
	// like "Total size: 12.3 kB" as the last line instead of the path).
	// Sort deterministically so a future multi-tarball scenario does not
	// rely on directory iteration order.
	const tgzs = readdirSync(tmpDir)
		.filter((f) => f.endsWith(".tgz"))
		.sort();
	if (tgzs.length > 0) {
		const abs = path.join(tmpDir, tgzs[0]);
		if (existsSync(abs)) return abs;
	}
	throw new Error(
		`pnpm pack did not produce a discoverable tarball; stdout was:\n${stdout}`,
	);
}

describe("@c9up/inker standalone smoke (AC1, AC2, AC6)", () => {
	let tmpDir = "";
	let consumerDir = "";

	beforeAll(() => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "inker-smoke-"));

		// 1. pack inker into a tarball
		const packOut = runPnpm(["pack", "--pack-destination", tmpDir], PKG_ROOT);
		const tarballPath = tarballFromPackOutput(packOut, tmpDir);

		// 2. seed the consumer (NO @c9up/ream, NO @c9up/rosetta)
		consumerDir = path.join(tmpDir, "consumer");
		mkdirSync(consumerDir, { recursive: true });
		writeFileSync(
			path.join(consumerDir, "package.json"),
			`${JSON.stringify(
				{
					name: "inker-smoke-consumer",
					private: true,
					type: "module",
					dependencies: { "@c9up/inker": `file:${tarballPath}` },
					devDependencies: { tsx: "*" },
				},
				null,
				2,
			)}\n`,
		);

		// 3. seed templates exercising every axis required by AC1
		const tplDir = path.join(consumerDir, "templates");
		mkdirSync(path.join(tplDir, "layouts"), { recursive: true });
		mkdirSync(path.join(tplDir, "partials"), { recursive: true });

		writeFileSync(
			path.join(tplDir, "layouts/main.inker"),
			"<html><head><title>{{ title }}</title></head><body>{% include 'partials/header' %}{{> body }}</body></html>",
		);
		writeFileSync(
			path.join(tplDir, "partials/header.inker"),
			"<header>{{ shout(title) }}</header>",
		);
		writeFileSync(
			path.join(tplDir, "invoice.inker"),
			[
				"{% layout 'layouts/main' %}",
				"{% if total > 0 %}",
				"<h1>Invoice for {{ user.name }}</h1>",
				"<ul>",
				"{% each items as item %}",
				"<li>{{ item }}</li>",
				"{% endeach %}",
				"</ul>",
				"{% endif %}",
			].join(""),
		);

		// 4. seed the consumer entrypoint
		writeFileSync(
			path.join(consumerDir, "index.mjs"),
			[
				"import { Templates } from '@c9up/inker';",
				"import path from 'node:path';",
				"import { fileURLToPath } from 'node:url';",
				"const here = path.dirname(fileURLToPath(import.meta.url));",
				"const templates = new Templates({",
				"  root: path.join(here, 'templates'),",
				"  helpers: new Map([['shout', (s) => String(s).toUpperCase()]]),",
				"});",
				"const html = await templates.render('invoice', {",
				"  title: 'hi',",
				"  user: { name: 'Alice' },",
				"  total: 1,",
				"  items: ['a', 'b'],",
				"});",
				"process.stdout.write(html);",
			].join("\n"),
		);

		// 5. install
		runPnpm(
			["install", "--ignore-workspace", "--no-frozen-lockfile"],
			consumerDir,
		);

		// 6. sanity: @c9up/ream MUST NOT be present in the consumer
		//    node_modules (peerDependenciesMeta.optional should have suppressed
		//    it). If it leaked in, the smoke is a false-pass.
		const leakedReam = path.join(consumerDir, "node_modules", "@c9up", "ream");
		const leakedRosetta = path.join(
			consumerDir,
			"node_modules",
			"@c9up",
			"rosetta",
		);
		if (existsSync(leakedReam)) {
			throw new Error(
				`@c9up/ream leaked into the consumer's node_modules (${leakedReam}) — peerDependenciesMeta.optional is broken.`,
			);
		}
		if (existsSync(leakedRosetta)) {
			throw new Error(
				`@c9up/rosetta leaked into the consumer's node_modules (${leakedRosetta}) — peerDependenciesMeta.optional is broken.`,
			);
		}
	}, SMOKE_TIMEOUT_MS);

	afterAll(() => {
		if (tmpDir !== "") {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it(
		"renders a composite template via leaf @c9up/inker without ream/rosetta installed",
		() => {
			const stdout = runChild(
				"node",
				["--import", "tsx", "index.mjs"],
				consumerDir,
			);

			// Layout + partial + helper + interpolation + if + each
			expect(stdout).toContain("<html>");
			expect(stdout).toContain("<title>hi</title>");
			expect(stdout).toContain("<header>HI</header>");
			expect(stdout).toContain("<h1>Invoice for Alice</h1>");
			expect(stdout).toContain("<li>a</li>");
			expect(stdout).toContain("<li>b</li>");
			expect(stdout).toMatch(/<\/html>\s*$/);
			// Silent-degrade guard: a broken render emitting literal directive
			// markers would still satisfy the toContain checks above because the
			// layout itself contributes `<html>` and `<title>hi</title>`.
			expect(stdout).not.toMatch(/\{\{|\{%/);
		},
		SMOKE_TIMEOUT_MS,
	);

	it(
		"imports @c9up/inker/provider without ream/rosetta installed",
		() => {
			const stdout = runChild(
				"node",
				[
					"--import",
					"tsx",
					"-e",
					"import('@c9up/inker/provider')" +
						".then(m => process.stdout.write(typeof m.default))" +
						".catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });",
				],
				consumerDir,
			);
			expect(stdout.trim()).toBe("function");
		},
		SMOKE_TIMEOUT_MS,
	);

	it(
		"imports @c9up/inker/provider/services/main without ream/rosetta installed",
		() => {
			// Third advertised export — Adonis-style singleton accessor. Its
			// default is a typed Proxy<InkerRenderer>, so typeof is "object".
			// Verifying the import does not throw + the default is non-null
			// covers AC5 sub-path completeness from the consumer side.
			const stdout = runChild(
				"node",
				[
					"--import",
					"tsx",
					"-e",
					"import('@c9up/inker/provider/services/main')" +
						".then(m => process.stdout.write(typeof m.default + ':' + String(m.default !== null && m.default !== undefined)))" +
						".catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });",
				],
				consumerDir,
			);
			expect(stdout.trim()).toBe("object:true");
		},
		SMOKE_TIMEOUT_MS,
	);
});
