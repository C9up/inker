import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";

// 62-3 — Edge multi-section layouts: @section / @endsection / @super.
// (Tags need a boundary after them, like Edge — sections here end at EOF or `@`.)
describe("Templates — @section / @super layouts (62-3)", () => {
	let root: string;
	beforeEach(() => {
		root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "inker-sec-")),
		);
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	const write = (name: string, src: string): void => {
		fs.writeFileSync(path.join(root, name), src);
	};

	it("a child section fills the layout's matching yield", async () => {
		write(
			"layout.inker",
			"<title>@section('title')Default@endsection</title>|{{> body }}",
		);
		write(
			"page.inker",
			"@layout('layout')BODY@section('title')Hello@endsection",
		);
		const out = await new Templates({ root }).render("page", {});
		expect(out).toBe("<title>Hello</title>|BODY");
	});

	it("an unfilled yield renders the layout's default content", async () => {
		write(
			"layout.inker",
			"<title>@section('title')Default@endsection</title>|{{> body }}",
		);
		write("page.inker", "@layout('layout')just body");
		const out = await new Templates({ root }).render("page", {});
		expect(out).toBe("<title>Default</title>|just body");
	});

	it("@super injects the layout's default into the child section", async () => {
		write("layout.inker", "@section('scripts')base@endsection|{{> body }}");
		write(
			"page.inker",
			"@layout('layout')B@section('scripts')@super+extra@endsection",
		);
		const out = await new Templates({ root }).render("page", {});
		expect(out).toBe("base+extra|B");
	});

	it("sections evaluate expressions + helpers in the child's data scope", async () => {
		write("layout.inker", "[@section('head')x@endsection]{{> body }}");
		write(
			"page.inker",
			"@layout('layout')body@section('head'){{ title }}@endsection",
		);
		const out = await new Templates({ root }).render("page", { title: "T" });
		expect(out).toBe("[T]body");
	});

	it("multiple sections + default body all compose", async () => {
		write(
			"layout.inker",
			"H:@section('h')-@endsection F:@section('f')-@endsection B:{{> body }}",
		);
		write(
			"page.inker",
			"@layout('layout')middle@section('h')head@endsection@section('f')foot@endsection",
		);
		const out = await new Templates({ root }).render("page", {});
		expect(out).toBe("H:head F:foot B:middle");
	});

	it("renders a child made only of @section fills", async () => {
		// The canonical layout shape: the layout exposes named yields and no
		// `{{> body }}`, the child fills them and has no body of its own. It was
		// rejected with "has no {{> body }} placeholder" because a top-level
		// `@section` counted as body content.
		write(
			"layout.inker",
			"<h>@section('head')d@endsection</h><b>@section('body')d@endsection</b>",
		);
		write(
			"page.inker",
			"@layout('layout')@section('head'){{ title }}@endsection@section('body')hi@endsection",
		);
		expect(await new Templates({ root }).render("page", { title: "T" })).toBe(
			"<h>T</h><b>hi</b>",
		);
	});

	it("still demands {{> body }} when the child HAS body content", async () => {
		write("layout.inker", "<h>@section('head')d@endsection</h>");
		write(
			"page.inker",
			"@layout('layout')loose text@section('head')x@endsection",
		);
		await expect(new Templates({ root }).render("page")).rejects.toThrow(
			/has no {{> body }}/,
		);
	});

	it("still rejects @layout after a @section", async () => {
		write("layout.inker", "@section('a')d@endsection");
		write("page.inker", "@section('a')x@endsection@layout('layout')");
		await expect(new Templates({ root }).render("page")).rejects.toThrow();
	});
});
