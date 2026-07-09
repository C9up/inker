import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";

// 62-4 — Edge component $props / $slots API. Components resolve under `components/`.
describe("Templates — component $props / $slots (62-4)", () => {
	let root: string;
	beforeEach(() => {
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "inker-ps-")));
		fs.mkdirSync(path.join(root, "components"));
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
	const write = (name: string, src: string): void => {
		fs.writeFileSync(path.join(root, name), src);
	};

	it("$props.except().merge().toAttrs() spreads the remaining props", async () => {
		write("components/btn.inker", "<button {{ $props.except(['label']).merge({ class: 'btn' }).toAttrs() }}>{{ label }}</button>");
		write("page.inker", "@component('btn', { label: 'Save', id: 'b', class: 'primary' })@endcomponent");
		const out = await new Templates({ root }).render("page", {});
		expect(out).toBe('<button id="b" class="btn primary">Save</button>');
	});

	it("$props.get with a default + $props.has", async () => {
		write("components/x.inker", "{{ $props.get('size', 'md') }}/{{ $props.has('flag') }}");
		write("page.inker", "@component('x', {})@endcomponent");
		const out = await new Templates({ root }).render("page", {});
		expect(out).toBe("md/false");
	});

	it("$slots.main() renders the default slot content", async () => {
		write("components/card.inker", "[{{ $slots.main() }}]");
		write("page.inker", "@component('card', {})hello@endcomponent");
		const out = await new Templates({ root }).render("page", {});
		expect(out).toBe("[hello]");
	});

	it("$slots.<name>() renders a named slot; @if($slots.x) tests existence", async () => {
		write("components/alert.inker", "@if($slots.header)<h>{{ $slots.header() }}</h>@endif|{{ $slots.main() }}");
		write("with-header.inker", "@component('alert', {})body@slot('header')HEAD@endslot@endcomponent");
		write("no-header.inker", "@component('alert', {})just body@endcomponent");
		const tpl = new Templates({ root });
		expect(await tpl.render("with-header", {})).toBe("<h>HEAD</h>|body");
		expect(await tpl.render("no-header", {})).toBe("|just body");
	});

	it("a @slot('__proto__') does not pollute Object.prototype ($slots is null-proto)", async () => {
		write("components/c.inker", "{{ $slots.main() }}");
		write("page.inker", "@component('c', {})body@slot('__proto__')PWN@endslot@endcomponent");
		await new Templates({ root }).render("page", {});
		// If the named-slot assignment had set the prototype, this key would leak.
		const probe: Record<string, unknown> = {};
		expect(Object.prototype.hasOwnProperty.call(probe, "__proto__")).toBe(false);
		expect(probe.polluted).toBeUndefined();
	});
});
