import os from "node:os";
import { describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";

// Expected outputs are what edge.js 6.5.1 renders, except where inker is
// deliberately stricter (attribute values escaped, unsafe names dropped).

function engine(): Templates {
	return new Templates({ root: os.tmpdir(), cacheMode: "never" });
}

function withComponent(component: string, page: string): Templates {
	const t = engine();
	t.registerTemplate("components/c", { template: component });
	t.registerTemplate("page", { template: page });
	return t;
}

describe("$props", () => {
	it("exposes each prop as a property, and reads dot paths", async () => {
		const t = withComponent(
			"[{{ $props.title }}|{{ $props.get('user.name') }}|{{ $props.has('user.name') }}|{{ $props.has('user.age') }}]",
			"@!component('c', { title: 'T', user: { name: 'Ada' } })",
		);
		expect(await t.render("page")).toBe("[T|Ada|true|false]");
	});

	it("keeps the API methods when a prop shares their name", async () => {
		const t = withComponent(
			"{{ $props.get('all') }}|{{ typeof $props.all }}",
			"@!component('c', { all: 'x' })",
		);
		expect(await t.render("page")).toBe("x|function");
	});

	it("refuses a prototype segment in a dot path", async () => {
		const t = withComponent(
			"[{{ $props.get('user.__proto__', 'none') }}|{{ $props.has('user.constructor') }}|{{ $props.get('user.constructor.name', 'none') }}]",
			"@!component('c', { user: { name: 'Ada' } })",
		);
		expect(await t.render("page")).toBe("[none|false|none]");
	});

	it("merges class across string, array and object forms", async () => {
		const t = withComponent(
			"<b {{ $props.merge({ class: ['btn', 'y'] }).toAttrs() }}></b>",
			"@!component('c', { class: 'x' })",
		);
		expect(await t.render("page")).toBe('<b class="btn y x"></b>');
		const objects = withComponent(
			"<b {{ $props.merge({ class: { base: true, off: false } }).toAttrs() }}></b>",
			"@!component('c', { class: ['x', { on: true }] })",
		);
		expect(await objects.render("page")).toBe('<b class="base x on"></b>');
	});
});

describe("html.attrs", () => {
	it("runs class through classNames", () => {
		expect(
			engine().renderString(
				"<a {{ html.attrs({ class: ['a', { b: true, c: false }] }) }}>",
			),
		).toBe('<a class="a b">');
	});

	it("joins other arrays with a space", () => {
		expect(
			engine().renderString(
				"<a {{ html.attrs({ rel: ['noopener', 'noreferrer'] }) }}>",
			),
		).toBe('<a rel="noopener noreferrer">');
	});

	it("still escapes every value, class entries included", () => {
		expect(
			engine().renderString(
				"<a {{ html.attrs({ class: ['a\"b'], title: v }) }}>",
				{
					v: '"><script>x</script>',
				},
			),
		).toBe(
			'<a class="a&quot;b" title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;">',
		);
	});
});
