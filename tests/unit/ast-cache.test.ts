import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getNative } from "../../src/loadNapi.js";
import { Templates } from "../../src/Templates.js";

function writeTree(files: Record<string, string>): string {
	const root = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-ast-cache-")),
	);
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, source);
	}
	return root;
}

describe("parsed-template cache", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders a cached composition without a native call per render", async () => {
		const root = writeTree({
			"layouts/main.inker": "<main>{{> body }}</main>",
			"partials/nav.inker": "<nav>{{ title }}</nav>",
			"components/card.inker": "<div>{{{ $slots.main() }}}</div>",
			"page.inker":
				"@layout('layouts/main')\n@include('partials/nav')@component('card')x@endcomponent",
		});
		for (const cacheMode of ["mtime", "never"] as const) {
			const templates = new Templates({ root, cacheMode });
			const expected = "<main><nav>T</nav><div>x</div></main>";
			expect(await templates.render("page", { title: "T" })).toBe(expected);

			const native = getNative();
			const toJson = vi.spyOn(native, "astToJson");
			const parse = vi.spyOn(native, "parseTemplate");
			expect(await templates.render("page", { title: "T" })).toBe(expected);
			expect(templates.renderSync("page", { title: "T" })).toBe(expected);
			// The layout, the page, the partial and the component were each
			// converted once, on the first render; the cache serves them since.
			expect(toJson).not.toHaveBeenCalled();
			expect(parse).not.toHaveBeenCalled();
			vi.restoreAllMocks();
		}
	});
});
