/**
 * Components exposed as tags — Edge's bundled `supercharged` plugin.
 * `components/button.inker` becomes `@button(...)…@endbutton`, which parses
 * into the ordinary component form, so slots, `$props`, `$caller` and
 * `$context` all behave exactly as with `@component('components/button')`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";

let root: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "inker-comp-tags-"));
});
afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function withTemplates(files: Record<string, string>): Templates {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(dir, `${name}.inker`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, source);
	}
	return new Templates({ root: dir, cacheMode: "never" });
}

describe("inker > components as tags", () => {
	it("renders a component through its tag name", async () => {
		const t = withTemplates({
			"components/button": "<button>{{{ $slots.main() }}}</button>",
			page: "@button()click@endbutton",
		});
		expect(await t.render("page")).toBe("<button>click</button>");
	});

	it("passes props through the tag's argument", async () => {
		const t = withTemplates({
			"components/button":
				"<button class='{{ size }}'>{{{ $slots.main() }}}</button>",
			page: "@button({ size: 'lg' })go@endbutton",
		});
		expect(await t.render("page")).toBe("<button class='lg'>go</button>");
	});

	it("supports the self-closing @!tag form", async () => {
		const t = withTemplates({
			"components/rule": "<hr class='{{ tone }}'>",
			page: "a@!rule({ tone: 'soft' })b",
		});
		expect(await t.render("page")).toBe("a<hr class='soft'>b");
	});

	it("nests a directory as a dotted tag name", async () => {
		const t = withTemplates({
			"components/form/input": "<input name='{{ name }}'>",
			page: "@!form.input({ name: 'email' })",
		});
		expect(await t.render("page")).toBe("<input name='email'>");
	});

	it("drops an index segment so a directory names itself", async () => {
		const t = withTemplates({
			"components/form/index": "<form>{{{ $slots.main() }}}</form>",
			page: "@form()fields@endform",
		});
		expect(await t.render("page")).toBe("<form>fields</form>");
	});

	it("camel-cases a dashed file name", async () => {
		const t = withTemplates({
			"components/date-picker": "<div class='dp'></div>",
			page: "@!datePicker()",
		});
		expect(await t.render("page")).toBe("<div class='dp'></div>");
	});

	it("carries named slots, exactly as @component does", async () => {
		const t = withTemplates({
			"components/card":
				"<section>{{{ $slots.main() }}}<footer>{{{ $slots.footer() }}}</footer></section>",
			page: "@card()body@slot('footer')feet@endslot@endcard",
		});
		expect(await t.render("page")).toBe(
			"<section>body<footer>feet</footer></section>",
		);
	});

	it("nests component tags", async () => {
		const t = withTemplates({
			"components/box": "[{{{ $slots.main() }}}]",
			page: "@box()@box()x@endbox@endbox",
		});
		expect(await t.render("page")).toBe("[[x]]");
	});

	it("leaves an unknown @word as literal text", async () => {
		const t = withTemplates({
			"components/button": "<button></button>",
			page: "write to @nobody about @media queries",
		});
		expect(await t.render("page")).toBe(
			"write to @nobody about @media queries",
		);
	});

	it("lists the components it exposes", () => {
		const t = withTemplates({
			"components/button": "x",
			"components/form/input": "y",
			other: "z",
		});
		const [{ diskName, components }] = t.listComponents();
		expect(diskName).toBe("default");
		expect(components.map((c) => c.tagName).sort()).toEqual([
			"button",
			"form.input",
		]);
		// Bare paths: inker's `@component()` resolves under `components/` itself.
		expect(components.map((c) => c.componentName).sort()).toEqual([
			"button",
			"form/input",
		]);
	});

	it("reports no components when the directory is absent", () => {
		const t = withTemplates({ page: "hi" });
		expect(t.listComponents()).toEqual([
			{ diskName: "default", components: [] },
		]);
	});
});
