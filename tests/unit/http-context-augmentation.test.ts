/**
 * `ctx.view` has to exist for the compiler, not just at runtime.
 *
 * `InkerProvider.start()` installs it as a context getter, seeded with the
 * request, so a controller renders without threading anything. The property
 * existed at run time and not for the compiler: every `ctx.view.render(...)`
 * was a type error in an application that had done nothing wrong.
 *
 * A type-only failure is invisible to a runtime suite, so this is asserted by
 * compiling a snippet the way an application would.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
let scratch: string | undefined;

afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = undefined;
});

/** Typecheck `source` against this package, and hand back what tsc said. */
function typecheck(source: string): { ok: boolean; output: string } {
	// Inside the package: module resolution has to find `@c9up/ream` and this
	// package the way an application's would, which a directory outside the
	// tree cannot.
	scratch = mkdtempSync(path.join(packageRoot, ".augmentation-check-"));
	const file = path.join(scratch, "snippet.ts");
	writeFileSync(file, source);
	try {
		execFileSync(
			process.execPath,
			[
				path.join(packageRoot, "node_modules/typescript/bin/tsc"),
				"--noEmit",
				"--ignoreConfig",
				"--strict",
				"--module",
				"nodenext",
				"--moduleResolution",
				"nodenext",
				"--target",
				"es2022",
				"--skipLibCheck",
				"--experimentalDecorators",
				"--emitDecoratorMetadata",
				"--types",
				"node",
				"--lib",
				"es2022,dom",
				file,
			],
			{ cwd: packageRoot, encoding: "utf8", stdio: "pipe" },
		);
		return { ok: true, output: "" };
	} catch (error) {
		const shown = error as { stdout?: string; stderr?: string };
		return { ok: false, output: `${shown.stdout ?? ""}${shown.stderr ?? ""}` };
	}
}

describe("inker > what a controller writes must typecheck", () => {
	it("accepts `ctx.view.render(name, data)` in a controller", () => {
		const result = typecheck(`
			import type { HttpContext } from '@c9up/ream'
			import '@c9up/inker'

			export default class HomeController {
			  async index(ctx: HttpContext) {
			    return ctx.view.render('home', { greeting: 'hi' })
			  }
			}
		`);
		expect(result.output).toBe("");
		expect(result.ok).toBe(true);
	});

	it("still refuses a property nothing attaches", () => {
		// The augmentation must add what the middleware sets, not open the
		// context to anything.
		const result = typecheck(`
			import type { HttpContext } from '@c9up/ream'
			import '@c9up/inker'

			export function handler(ctx: HttpContext) {
			  return ctx.nothingSetsThis
			}
		`);
		expect(result.ok).toBe(false);
	});
}, 60_000);
