/**
 * Engine-level state sharing: `global()`, `use()` and `createRenderer()`.
 *
 * These are the three Edge APIs a plugin needs. Without them a package like
 * rosetta cannot publish `t()` to templates: its i18n plugin is written against
 * `edge.global(name, value)` and had nothing to call.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";

let root: string;

beforeAll(() => {
	// `realpathSync.native`, the SAME call `Templates` canonicalises its root
	// with — every makePath/mounted assertion below compares against this value.
	// Plain `realpathSync` is not enough: it resolves macOS's /var -> /private/var
	// but leaves Windows' 8.3 short name alone (RUNNER~1 vs runneradmin), so the
	// two would still disagree there. Linux passes either way, tmp being
	// canonical already.
	root = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-globals-")),
	);
});
afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function engine(): Templates {
	return new Templates({ root, cacheMode: "never" });
}

describe("inker > Templates#global", () => {
	it("puts a value in scope for every template", () => {
		const t = engine();
		t.global("siteName", "Ream");
		expect(t.renderString("{{ siteName }}")).toBe("Ream");
	});

	it("lets per-render data win over a global of the same name", () => {
		const t = engine();
		t.global("title", "default");
		expect(t.renderString("{{ title }}", { title: "override" })).toBe(
			"override",
		);
	});

	it("shares functions, not just data", () => {
		const t = engine();
		t.global("shout", (s: string) => `${s}!`);
		expect(t.renderString("{{ shout('hi') }}")).toBe("hi!");
	});

	it("rejects a name that is not a valid identifier", () => {
		const t = engine();
		expect(() => t.global("not a name", 1)).toThrow(/not a valid identifier/);
	});

	it("rejects a prototype-pollution key", () => {
		const t = engine();
		expect(() => t.global("__proto__", {})).toThrow(/prototype-pollution/);
		// The engine must be unharmed: a later render still resolves normally.
		expect(t.renderString("{{ 1 + 1 }}")).toBe("2");
	});
});

describe("inker > Templates#use", () => {
	it("runs a plugin that registers globals — the shape rosetta's i18n plugin expects", () => {
		const t = engine();
		const i18nPlugin = (engineArg: { global(n: string, v: unknown): void }) => {
			engineArg.global("t", (key: string) => `translated:${key}`);
			engineArg.global("locale", "fr");
		};
		t.use(i18nPlugin);
		expect(t.renderString("{{ t('welcome') }} {{ locale }}")).toBe(
			"translated:welcome fr",
		);
	});

	it("returns the engine so calls chain", () => {
		const t = engine();
		expect(t.use(() => {})).toBe(t);
	});

	it("rejects a non-function plugin", () => {
		// Parsed, not cast: the point is what an untyped caller can hand over.
		const t = engine();
		expect(() => t.use(JSON.parse("42"))).toThrow(/Plugin must be a function/);
	});
});

describe("inker > Templates#createRenderer", () => {
	it("isolates shared state between renderers", () => {
		const t = engine();
		const a = t.createRenderer().share({ url: "/posts" });
		const b = t.createRenderer().share({ url: "/posts/1" });
		expect(a.renderString("{{ url }}")).toBe("/posts");
		expect(b.renderString("{{ url }}")).toBe("/posts/1");
	});

	it("keeps shared state out of the engine itself", () => {
		const t = engine();
		t.createRenderer().share({ secret: "leaked" });
		// inker is strict on unknown identifiers, so the leak would surface as a
		// rendered value; absence is proven by the reference failing to resolve.
		expect(() => t.renderString("{{ secret }}")).toThrow(/not defined/);
	});

	it("layers engine global < shared < render data", () => {
		const t = engine();
		t.global("who", "global");
		const r = t.createRenderer().share({ who: "shared" });
		expect(r.renderString("{{ who }}")).toBe("shared");
		expect(r.renderString("{{ who }}", { who: "local" })).toBe("local");
	});

	it("rejects a non-object passed to share()", () => {
		const t = engine();
		expect(() => t.createRenderer().share(null as never)).toThrow(
			/share\(\) expects an object/,
		);
	});
});

describe("inker > engine API completed against edge.js 6.5.1", () => {
	it("mount takes the one-argument form", () => {
		const dir = fs.mkdtempSync(path.join(root, "single-mount-"));
		fs.writeFileSync(path.join(dir, "hi.inker"), "mounted");
		const t = engine();
		// Edge's `edge.mount(new URL('./views', import.meta.url))` form.
		t.mount(dir);
		expect(t.renderString("{{ 'ok' }}")).toBe("ok");
	});

	it("onRender seeds every renderer the engine creates", () => {
		const t = engine();
		let created = 0;
		t.onRender((renderer) => {
			created += 1;
			renderer.share({ requestId: `r${created}` });
		});
		expect(t.createRenderer().renderString("{{ requestId }}")).toBe("r1");
		expect(t.createRenderer().renderString("{{ requestId }}")).toBe("r2");
	});

	it("share() on the engine hands back a renderer, never mutating the engine", () => {
		const t = engine();
		const renderer = t.share({ user: "ada" });
		expect(renderer.renderString("{{ user }}")).toBe("ada");
		// The engine itself stayed clean, so the next request starts empty.
		expect(t.renderString("{{ typeof user }}")).toBe("undefined");
	});

	it("clone copies the shared state without linking the two renderers", () => {
		const t = engine();
		const base = t.createRenderer().share({ a: "1" });
		const copy = base.clone().share({ b: "2" });
		expect(copy.renderString("{{ a }}{{ b }}")).toBe("12");
		expect(base.renderString("{{ a }}{{ typeof b }}")).toBe("1undefined");
	});

	it("clone does not re-run the onRender callbacks", () => {
		const t = engine();
		let calls = 0;
		t.onRender(() => {
			calls += 1;
		});
		t.createRenderer().clone();
		expect(calls).toBe(1);
	});

	it("getState layers shared values over the engine globals", () => {
		const t = engine();
		t.global("siteName", "Ream");
		t.global("title", "default");
		const state = t.createRenderer().share({ title: "override" }).getState();
		expect(state.siteName).toBe("Ream");
		expect(state.title).toBe("override");
	});

	it("renderRaw / renderRawSync exist on a renderer too", async () => {
		const renderer = engine().createRenderer().share({ n: 2 });
		expect(renderer.renderRawSync("{{ n }}")).toBe("2");
		await expect(renderer.renderRaw("{{ n }}")).resolves.toBe("2");
	});

	it("configure swaps the cache mode and rejects an unknown one", () => {
		const t = engine();
		t.configure({ cacheMode: "never" });
		expect(t.renderString("{{ 'still works' }}")).toBe("still works");
		// Parsed, not cast: the point is what an untyped caller can hand over.
		const bad = JSON.parse('{"cacheMode":"nope"}');
		expect(() => t.configure(bad)).toThrow(/cacheMode must be one of/);
	});
});

describe("inker > Templates#use — Edge's deferred plugin model", () => {
	it("defers a plugin to the first render, not to use()", () => {
		const t = engine();
		let ran = false;
		t.use(() => {
			ran = true;
		});
		expect(ran).toBe(false);
		// Deferring is why a plugin registered before mount()/configure() still
		// observes the engine as it ends up rather than as it was mid-boot.
		t.renderString("x");
		expect(ran).toBe(true);
	});

	it("runs a plugin once, however many renders follow", () => {
		const t = engine();
		let runs = 0;
		t.use(() => {
			runs += 1;
		});
		t.renderString("a");
		t.renderString("b");
		t.createRenderer();
		expect(runs).toBe(1);
	});

	it("re-runs a recurring plugin on every render", () => {
		const t = engine();
		let runs = 0;
		t.use(
			() => {
				runs += 1;
			},
			{ recurring: true },
		);
		t.renderString("a");
		t.renderString("b");
		expect(runs).toBe(2);
	});

	it("passes firstRun and the registration options through", () => {
		const t = engine();
		const seen: { firstRun: boolean; label: string | undefined }[] = [];
		t.use(
			(_engine, firstRun, options) => {
				seen.push({ firstRun, label: options?.label });
			},
			{ recurring: true, label: "i18n" },
		);
		t.renderString("a");
		t.renderString("b");
		expect(seen).toEqual([
			{ firstRun: true, label: "i18n" },
			{ firstRun: false, label: "i18n" },
		]);
	});

	it("does not recurse when a plugin renders", () => {
		const t = engine();
		let runs = 0;
		t.use((engineArg) => {
			runs += 1;
			engineArg.renderString("inner");
		});
		t.renderString("outer");
		expect(runs).toBe(1);
	});
});

describe("inker > the loader surface Edge puts on edge.loader", () => {
	it("makePath reports where a template name resolves to", () => {
		const t = engine();
		expect(t.makePath("page")).toBe(path.join(root, "page.inker"));
	});

	it("makePath honours a disk prefix", () => {
		const dir = fs.mkdtempSync(path.join(root, "disk-"));
		const t = engine();
		t.mount("admin", dir);
		expect(t.makePath("admin::dash")).toBe(path.join(dir, "dash.inker"));
	});

	it("makePath refuses to escape the root", () => {
		expect(() => engine().makePath("../outside")).toThrow();
	});

	it("resolve returns a template's source from disk", () => {
		const dir = fs.mkdtempSync(path.join(root, "src-"));
		fs.writeFileSync(path.join(dir, "hello.inker"), "hi {{ name }}");
		const t = new Templates({ root: dir, cacheMode: "never" });
		expect(t.resolve("hello")).toEqual({ template: "hi {{ name }}" });
	});

	it("resolve prefers an in-memory template, as a render does", () => {
		const dir = fs.mkdtempSync(path.join(root, "mem-"));
		fs.writeFileSync(path.join(dir, "hello.inker"), "from disk");
		const t = new Templates({ root: dir, cacheMode: "never" });
		t.registerTemplate("hello", { template: "from memory" });
		expect(t.resolve("hello")).toEqual({ template: "from memory" });
	});

	it("resolve reports a missing template by path", () => {
		expect(() => engine().resolve("nope")).toThrow(/Template not found/);
	});

	it("mounted lists the default root plus every mounted disk", () => {
		const dir = fs.mkdtempSync(path.join(root, "m-"));
		const t = engine();
		t.mount("admin", dir);
		expect(t.mounted.default).toBe(root);
		expect(t.mounted.admin).toBe(fs.realpathSync(dir));
	});

	it("templates lists what registerTemplate holds", () => {
		const t = engine();
		expect(Object.keys(t.templates)).toEqual([]);
		t.registerTemplate("inline", { template: "x" });
		expect(t.templates.inline).toEqual({ template: "x" });
		t.removeTemplate("inline");
		expect(Object.keys(t.templates)).toEqual([]);
	});

	it("names the two Edge processor stages inker cannot honour", () => {
		const t = engine();
		// Parsed, not cast: these stages are unreachable through the typed
		// overloads, so the point is what an untyped caller can hand over.
		const compiled = JSON.parse('"compiled"');
		const tag = JSON.parse('"tag"');
		expect(() => t.processor.process(compiled, () => undefined)).toThrow(
			/no JavaScript is emitted/,
		);
		expect(() => t.processor.process(tag, () => undefined)).toThrow(
			/parsing happens in Rust/,
		);
	});
});
