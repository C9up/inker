/**
 * `renderSync` — the disk render AdonisJS offers alongside `render`.
 *
 * I refused it once, claiming a sync twin would duplicate the
 * O_NOFOLLOW/containment/realpath load path. It does not: the whole render is
 * ONE generator that asks for each load and each sub-render, and the two entry
 * points differ only in how they answer. The containment rule and the
 * composition run from a single place.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";

let root: string;
beforeAll(() => {
	root = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-sync-")),
	);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (name: string, src: string): void => {
	const file = path.join(root, `${name}.inker`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, src);
};

const engine = () => new Templates({ root, cacheMode: "never" });

describe("inker > renderSync", () => {
	it("renders a template from disk", () => {
		write("plain", "hi {{ name }}");
		expect(engine().renderSync("plain", { name: "Ada" })).toBe("hi Ada");
	});

	it("composes a layout, a partial and a component", () => {
		write("layouts/main", "<main>{{> body }}@include('partials/foot')</main>");
		write("partials/foot", "<f/>");
		write("components/badge", "<b>{{{ $slots.main() }}}</b>");
		write("page", "@layout('layouts/main')@component('badge')hi@endcomponent");
		expect(engine().renderSync("page")).toBe("<main><b>hi</b><f/></main>");
	});

	it("fills sections, exactly as the async path does", async () => {
		write("layouts/sec", "<t>@section('title')D@endsection</t>{{> body }}");
		write("secpage", "@layout('layouts/sec')B@section('title')T@endsection");
		const t = engine();
		expect(t.renderSync("secpage")).toBe(await t.render("secpage"));
	});

	it("fills a stack", () => {
		write("stacked", "@pushTo('s')<i>@endpushTo[@stack('s')]");
		expect(engine().renderSync("stacked")).toBe("[<i>]");
	});

	it("raises on an awaiting expression, as renderSync does upstream", () => {
		write("slow", "{{ await who() }}");
		const t = new Templates({
			root,
			cacheMode: "never",
			helpers: new Map([["who", () => Promise.resolve("Ada")]]),
		});
		expect(() => t.renderSync("slow")).toThrow(/cannot use `await`/);
	});

	it("keeps the containment guarantees of the async path", () => {
		expect(() => engine().renderSync("../escape")).toThrow();
	});

	it("reports a missing template the same way", () => {
		expect(() => engine().renderSync("nope")).toThrow(/not found|ENOENT/i);
	});

	it("agrees with render() on a template using every feature", async () => {
		write("components/card", "<c>{{ title }}{{{ $slots.main() }}}</c>");
		write(
			"kitchen",
			"@let(n = 2)@each(i in [1, 2])@!component('card', { title: i })@endeach|{{ n }}",
		);
		const t = engine();
		expect(t.renderSync("kitchen")).toBe(await t.render("kitchen"));
	});
});
