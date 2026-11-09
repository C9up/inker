/**
 * The Edge built-in tags inker was missing: `@assign`, `@inject` (with
 * `$context`), `@debugger`, `@newError`, `@stack` / `@pushTo` / `@pushOnceTo`,
 * and `@dd`.
 *
 * The list was taken from edge.js 6.5.1's own `src/tags/main.ts` barrel rather
 * than from memory — an earlier pass guessed it and missed four of them.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";

let root: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "inker-edge-tags-"));
});
afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function engine(): Templates {
	return new Templates({ root, cacheMode: "never" });
}

/** Write a template into a fresh subdirectory and return an engine on it. */
function withTemplates(files: Record<string, string>): Templates {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(dir, `${name}.inker`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, source);
	}
	return new Templates({ root: dir, cacheMode: "never" });
}

describe("inker > @assign", () => {
	it("re-assigns a binding declared by @let", () => {
		expect(engine().renderString("@let(n = 1)@assign(n = 2){{ n }}")).toBe("2");
	});

	it("accumulates across a loop — the write reaches the OUTER frame", () => {
		// The reason scope frames chain instead of being spread-copied: with a
		// copy per iteration, every `@assign` would be discarded at the `@endeach`.
		expect(
			engine().renderString(
				"@let(total = 0)@each(p in prices)@assign(total = total + p)@endeach{{ total }}",
				{ prices: [5, 10, 4] },
			),
		).toBe("19");
	});

	it("supports compound operators", () => {
		expect(engine().renderString("@let(n = 10)@assign(n += 5){{ n }}")).toBe(
			"15",
		);
		expect(
			engine().renderString("@let(n = null)@assign(n ??= 'fallback'){{ n }}"),
		).toBe("fallback");
	});

	it("assigns through a member path", () => {
		expect(
			engine().renderString("@assign(user.name = 'Ada'){{ user.name }}", {
				user: { name: "unset" },
			}),
		).toBe("Ada");
	});

	it("does not mistake a comparison for the assignment", () => {
		expect(
			engine().renderString(
				"@let(flag = false)@assign(flag = 1 === 1){{ flag }}",
			),
		).toBe("true");
	});

	it("never writes a bare-identifier assignment back into the caller's data", () => {
		// A reused data object (module-level defaults, a cached view model) must
		// render the same way twice: the render works on its own copy.
		const data = { count: 0 };
		const source = "@assign(count = count + 1){{ count }}";
		const t = engine();
		expect(t.renderString(source, data)).toBe("1");
		expect(t.renderString(source, data)).toBe("1");
		expect(data).toEqual({ count: 0 });
	});

	it("keeps the caller's data intact through render and renderSync", async () => {
		const t = withTemplates({ page: "@assign(count = count + 1){{ count }}" });
		const data = { count: 0 };
		expect(await t.render("page", data)).toBe("1");
		expect(t.renderSync("page", data)).toBe("1");
		expect(await t.createRenderer().share({ count: 5 }).render("page")).toBe(
			"6",
		);
		expect(data).toEqual({ count: 0 });
	});

	it("still mutates the object a member path points at", () => {
		const user = { name: "unset" };
		engine().renderString("@assign(user.name = 'Ada')", { user });
		expect(user.name).toBe("Ada");
	});

	it("reaches an outer @let from inside an @each", () => {
		expect(
			engine().renderString(
				"@let(seen = '')@each(c in list)@assign(seen = seen + c)@endeach{{ seen }}",
				{ list: ["a", "b"] },
			),
		).toBe("ab");
	});

	it("rejects an argument that is not an assignment", () => {
		expect(() => engine().renderString("@assign(a === b)")).toThrow(
			/requires an assignment/,
		);
	});
});

describe("inker > @inject and $context", () => {
	it("shares state from a component with its nested components", async () => {
		const t = withTemplates({
			"components/map":
				"@inject({ map: { markers: [] } })<div>{{{ $slots.main() }}}{{ $context.map.markers.length }}</div>",
			"components/marker": "@eval($context.map.markers.push(label))",
			page: "@component('map')@!component('marker', { label: 'a' })@!component('marker', { label: 'b' })@endcomponent",
		});
		// Two markers pushed into the map's injected context, counted after the
		// slot rendered — which only works because slots render on use.
		expect(await t.render("page")).toBe("<div>2</div>");
	});

	it("gives each component its own copy, so a sibling subtree is unaffected", async () => {
		const t = withTemplates({
			"components/outer": "@inject({ v: 'outer' }){{{ $slots.main() }}}",
			"components/inner": "@inject({ v: 'inner' }){{ $context.v }}",
			"components/reader": "{{ $context.v }}",
			page: "@component('outer')@!component('inner')|@!component('reader')@endcomponent",
		});
		expect(await t.render("page")).toBe("inner|outer");
	});

	it("errors outside a component scope", () => {
		expect(() => engine().renderString("@inject({ a: 1 })")).toThrow(
			/only be used inside a component/,
		);
	});

	it("rejects a non-object argument", async () => {
		const t = withTemplates({
			"components/bad": "@inject('nope')",
			page: "@!component('bad')",
		});
		await expect(t.render("page")).rejects.toThrow(/expects an object/);
	});

	it("ignores prototype-polluting keys", async () => {
		const t = withTemplates({
			"components/evil":
				"@inject(payload){{ $context.__proto__ === undefined ? 'clean' : 'polluted' }}",
			page: "@!component('evil', { payload: evil })",
		});
		const out = await t.render("page", {
			evil: JSON.parse('{"__proto__": {"owned": true}, "ok": 1}'),
		});
		expect(out).toBe("clean");
	});
});

describe("inker > @stack, @pushTo, @pushOnceTo", () => {
	it("fills a stack declared AFTER the pushes", () => {
		expect(
			engine().renderString(
				"@pushTo('s')<b>@endpushTo@pushTo('s')<i>@endpushTo[@stack('s')]",
			),
		).toBe("[<b>\n<i>]");
	});

	it("fills a stack in the layout from a push in the body", async () => {
		const t = withTemplates({
			"layouts/main": "<head>@stack('scripts')</head>{{> body }}",
			page: "@layout('layouts/main')@pushTo('scripts')<script src='a'></script>@endpushTo<p>hi</p>",
		});
		expect(await t.render("page")).toBe(
			"<head><script src='a'></script></head><p>hi</p>",
		);
	});

	it("pushes once per call site, however many times it renders", async () => {
		const t = withTemplates({
			"components/widget":
				"@pushOnceTo('scripts')<script>w</script>@endpushOnceTo<div>{{ n }}</div>",
			page: "@each(n in [1, 2, 3])@!component('widget', { n })@endeach[@stack('scripts')]",
		});
		expect(await t.render("page")).toBe(
			"<div>1</div><div>2</div><div>3</div>[<script>w</script>]",
		);
	});

	it("keys @pushOnceTo on the file holding it, not on the entry template", async () => {
		// Two different partials whose tag sits at the same line and column.
		const t = withTemplates({
			"partials/a": "@pushOnceTo('js')<script src=a></script>@endpushOnceTo",
			"partials/b": "@pushOnceTo('js')<script src=b></script>@endpushOnceTo",
			page: "@include('partials/a')@include('partials/b')[@stack('js')]",
		});
		// One line per pushed source, as Edge joins a stack.
		expect(await t.render("page")).toBe(
			"[<script src=a></script>\n<script src=b></script>]",
		);
	});

	it("names the partial itself in $filename and @newError", async () => {
		const t = withTemplates({
			"partials/a": "[{{ $filename }}]",
			"partials/boom": "@newError('nope')",
			page: "{{ $filename }}@include('partials/a')",
			broken: "@include('partials/boom')",
		});
		expect(await t.render("page")).toBe("page[partials/a]");
		try {
			await t.render("broken");
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(InkerRenderError);
			if (e instanceof InkerRenderError) {
				expect(e.context.templateName).toBe("partials/boom");
			}
		}
	});

	it("pushes once for one partial included twice", async () => {
		const t = withTemplates({
			"partials/a": "@pushOnceTo('js')<script src=a></script>@endpushOnceTo",
			page: "@include('partials/a')@include('partials/a')[@stack('js')]",
		});
		expect(await t.render("page")).toBe("[<script src=a></script>]");
	});

	it("tells a partial and a component of the same name apart", async () => {
		const t = withTemplates({
			x: "@pushOnceTo('js')<p>@endpushOnceTo",
			"components/x": "@pushOnceTo('js')<c>@endpushOnceTo",
			page: "@include('x')@!component('x')@!component('x')[@stack('js')]",
		});
		expect(await t.render("page")).toBe("[<p>\n<c>]");
	});

	it("does not collide between a layout and the page body", async () => {
		// Both tags sit at line 2, column 1 of their own file.
		const t = withTemplates({
			"layouts/main":
				"[@stack('js')]\n@pushOnceTo('js')<l>@endpushOnceTo{{> body }}",
			page: "@layout('layouts/main')\n@pushOnceTo('js')<p>@endpushOnceTo",
		});
		const out = await t.render("page");
		expect(out).toContain("<p>");
		expect(out).toContain("<l>");
	});

	it("does not RENDER a repeated @pushOnceTo body at all", () => {
		// hasSource and pushOnceTo once joined their key differently, so the
		// lookup never matched: the body was rendered on every repeat and only
		// then discarded — side effects included.
		let renders = 0;
		const t = new Templates({
			root,
			cacheMode: "never",
			helpers: new Map([
				[
					"tick",
					() => {
						renders += 1;
						return "";
					},
				],
			]),
		});
		const out = t.renderString(
			"@each(n in [1, 2, 3])@pushOnceTo('s'){{ tick() }}x@endpushOnceTo@endeach[@stack('s')]",
		);
		expect(out).toBe("[x]");
		expect(renders).toBe(1);
	});

	it("keeps @pushTo repeating where @pushOnceTo would not", () => {
		expect(
			engine().renderString(
				"@each(n in [1, 2])@pushTo('s'){{ n }}@endpushTo@endeach[@stack('s')]",
			),
		).toBe("[1\n2]");
	});

	it("renders the body in the surrounding scope", () => {
		expect(
			engine().renderString(
				"@let(who = 'world')@pushTo('s')hello {{ who }}@endpushTo[@stack('s')]",
			),
		).toBe("[hello world]");
	});

	it("rejects the same stack being output twice", () => {
		expect(() => engine().renderString("@stack('s')@stack('s')")).toThrow(
			/declared twice/,
		);
	});

	it("drops content pushed to a stack that is never output", () => {
		expect(engine().renderString("@pushTo('nowhere')x@endpushTo.")).toBe(".");
	});

	it("does not let @endpushTo close a @pushOnceTo", () => {
		expect(() => engine().renderString("@pushOnceTo('s')x@endpushTo")).toThrow(
			/does not match open @pushOnceTo/,
		);
	});

	it("cannot be forged from rendered data", () => {
		// The placeholder is salted per render, so a value that echoes a plausible
		// token is emitted as text rather than capturing the stack.
		const out = engine().renderString(
			"{{ evil }}@pushTo('s')SECRET@endpushTo[@stack('s')]",
			{ evil: " inker-stack:0:s " },
		);
		expect(out).toBe(" inker-stack:0:s [SECRET]");
	});
});

describe("inker > @newError", () => {
	it("raises with the given message", () => {
		expect(() => engine().renderString("@newError('boom')")).toThrow(/boom/);
	});

	it("carries the position the template chose", () => {
		try {
			engine().renderString("@newError('bad usage', 'caller.inker', 42, 7)");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(InkerRenderError);
			if (!(error instanceof InkerRenderError)) return;
			expect(error.code).toBe("E_INKER_TEMPLATE_ERROR");
			expect(error.context.line).toBe(42);
			expect(error.context.column).toBe(7);
			expect(error.context.templateName).toBe("caller.inker");
		}
	});

	it("lets a component blame its caller through $caller", async () => {
		const t = withTemplates({
			"components/strict":
				"@newError('needs a label', $caller.filename, $caller.line, $caller.col)",
			page: "hi\n@!component('strict')",
		});
		try {
			await t.render("page");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(InkerRenderError);
			if (!(error instanceof InkerRenderError)) return;
			expect(error.message).toBe("needs a label");
			expect(error.context.line).toBe(2);
		}
	});
});

describe("inker > @dd and @debugger", () => {
	it("@dd dumps the value and stops the render", () => {
		try {
			engine().renderString("before@dd(user)after", { user: { id: 7 } });
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(InkerRenderError);
			if (!(error instanceof InkerRenderError)) return;
			expect(error.code).toBe("E_INKER_DUMP_DIE");
			expect(error.message).toContain('"id": 7');
		}
	});

	it("@dump keeps rendering", () => {
		const out = engine().renderString("@dump(user)after", { user: 1 });
		expect(out).toContain("after");
	});

	it("@debugger renders nothing and takes no arguments", () => {
		expect(engine().renderString("a@debugger b")).toBe("a b");
		expect(() => engine().renderString("@debugger(x)")).toThrow(
			/Unexpected tokens after debugger/,
		);
	});
});

describe("inker > $filename and a nested $caller", () => {
	it("exposes the template's own name as $filename", async () => {
		const t = withTemplates({ page: "{{ $filename }}" });
		expect(await t.render("page")).toBe("page");
	});

	it("gives a component its OWN name, not the caller's", async () => {
		const t = withTemplates({
			"components/badge": "{{ $filename }}|{{ $caller.filename }}",
			page: "@!component('badge')",
		});
		expect(await t.render("page")).toBe("badge|page");
	});

	it("names the enclosing component as the caller one level down", async () => {
		// The sub-context used to drop `templateName`, so a component invoked
		// from inside ANOTHER component's template reported `$caller.filename`
		// as undefined. Note this is invocation from the component's own body,
		// not through a slot — slot content renders in the caller's scope and
		// therefore rightly reports the page.
		const t = withTemplates({
			"components/outer": "[@!component('inner')]",
			"components/inner": "{{ $caller.filename }}",
			page: "@!component('outer')",
		});
		expect(await t.render("page")).toBe("[outer]");
	});

	it("still reports the page as the caller for slot content", async () => {
		const t = withTemplates({
			"components/wrap": "{{{ $slots.main() }}}",
			"components/inner": "{{ $caller.filename }}",
			page: "@component('wrap')@!component('inner')@endcomponent",
		});
		expect(await t.render("page")).toBe("page");
	});

	it("lets render data shadow $filename without breaking it", async () => {
		const t = withTemplates({ page: "{{ $filename }}" });
		expect(await t.render("page", { $filename: "override" })).toBe("override");
	});
});

describe("inker > $lineNumber", () => {
	it("reports the line the expression sits on", async () => {
		const t = withTemplates({ page: "a\nb\n{{ $lineNumber }}" });
		expect(await t.render("page")).toBe("a\nb\n3");
	});

	it("tracks the line inside a block", async () => {
		const t = withTemplates({
			page: "@if(true)\n{{ $lineNumber }}\n@endif",
		});
		expect((await t.render("page")).trim()).toBe("2");
	});

	it("lets render data shadow it", async () => {
		const t = withTemplates({ page: "{{ $lineNumber }}" });
		expect(await t.render("page", { $lineNumber: "x" })).toBe("x");
	});
});
