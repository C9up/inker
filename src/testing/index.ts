/**
 * `@c9up/inker/testing` — render templates in a test without touching a real
 * views directory.
 *
 *   import { createTestTemplates } from "@c9up/inker/testing"
 *
 *   const t = createTestTemplates({
 *     templates: {
 *       "layouts/main": "<main>{{> body }}</main>",
 *       page: "@layout('layouts/main')Hello {{ name }}",
 *     },
 *   })
 *   expect(await t.render("page", { name: "Ada" })).toBe("<main>Hello Ada</main>")
 *   t.dispose()
 *
 * Templates are registered in memory, so layouts, partials and components
 * resolve between themselves with no files written. A real (empty) directory
 * still backs the engine so the containment checks a production render relies
 * on are the same ones a test exercises — `dispose()` removes it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HelperFn } from "../helpers.js";
import { Templates } from "../Templates.js";

export interface CreateTestTemplatesOptions {
	/** Template name → source, e.g. `{ page: "hi {{ name }}" }`. A component
	 * goes under its usual key (`components/button`), a layout under its own. */
	readonly templates?: Readonly<Record<string, string>>;
	/** Helpers callable from `{{ }}`, as the constructor takes them. */
	readonly helpers?: ReadonlyMap<string, HelperFn>;
	/** Values shared with every render (`Templates#global`). */
	readonly globals?: Readonly<Record<string, unknown>>;
}

export interface TestTemplates {
	/** The engine itself, for anything the shorthands do not cover. */
	readonly engine: Templates;
	render(
		name: string,
		data?: Readonly<Record<string, unknown>>,
	): Promise<string>;
	renderString(
		source: string,
		data?: Readonly<Record<string, unknown>>,
	): string;
	/** Remove the temporary root. Safe to call twice. */
	dispose(): void;
}

/** An engine backed by in-memory templates, ready to render. */
export function createTestTemplates(
	options: CreateTestTemplatesOptions = {},
): TestTemplates {
	// realpath: macOS hands back a symlinked /var/folders path, and the engine
	// canonicalises its root — an uncanonicalised one would fail containment.
	const root = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-test-")),
	);
	// `never` is the deterministic mode: a test that re-registers a template
	// must see the new source, and there is no file mtime to key off.
	const engine = new Templates({
		root,
		cacheMode: "never",
		helpers: options.helpers,
	});
	for (const [name, template] of Object.entries(options.templates ?? {})) {
		engine.registerTemplate(name, { template });
	}
	for (const [name, value] of Object.entries(options.globals ?? {})) {
		engine.global(name, value);
	}
	return {
		engine,
		render: (name, data = {}) => engine.render(name, data),
		renderString: (source, data = {}) => engine.renderString(source, data),
		dispose: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}
