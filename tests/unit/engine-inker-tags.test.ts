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

	it("rejects assigning to an undeclared binding", () => {
		expect(() => engine().renderString("@assign(ghost = 1)")).toThrow(
			/no such binding in scope/,
		);
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
		).toBe("[<b><i>]");
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
		).toBe("[12]");
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
