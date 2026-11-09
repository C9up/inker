import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import InkerProvider, {
	type InkerAppContext,
	resetInkerProviderFlags,
} from "../../src/InkerProvider.js";
import { InkerRenderError } from "../../src/InkerRenderError.js";
import type { InkerRenderer } from "../../src/InkerRenderer.js";
import inkerDefault, { plugins } from "../../src/index.js";
import { clearInker } from "../../src/services/main.js";
import type { Templates } from "../../src/Templates.js";
import { asTyped } from "../__helpers__/bypass-type-check.js";

function mkApp(appRoot: string): InkerAppContext {
	const resolved: Record<string, unknown> = {
		appRoot,
		router: {
			makeUrl: () => "/",
			urlFor: () => "/",
			makeSignedUrl: () => "/?signature=stub",
		},
		rosetta: { t: (key: string) => key },
	};
	const singletons = new Map<string, () => unknown>();
	return {
		container: {
			singleton<T>(token: unknown, factory: () => T) {
				singletons.set(String(token), factory);
			},
			async resolve<T = unknown>(token: unknown): Promise<T> {
				const key = String(token);
				if (key in resolved) return resolved[key] as T;
				const factory = singletons.get(key);
				if (factory) return (await factory()) as T;
				throw Object.assign(new Error(`[stub] no binding for ${key}`), {
					code: "E_CONTAINER_NOT_FOUND",
				});
			},
			has(token: unknown): boolean {
				const key = String(token);
				return key in resolved || singletons.has(key);
			},
		},
		config: {
			get<T = unknown>(): T | undefined {
				return undefined;
			},
		},
	};
}

/** The engine the provider built, through the renderer's documented seam. */
async function engineOf(app: InkerAppContext): Promise<Templates> {
	const renderer = await app.container.resolve<InkerRenderer>("inker");
	return renderer.templates;
}

describe("inker > plugin registrar", () => {
	beforeEach(() => {
		plugins.clear();
	});
	afterEach(() => {
		plugins.clear();
	});

	it("is the package's default export, the way the engine is upstream", () => {
		expect(inkerDefault).toBe(plugins);
	});

	it("queues rather than running, so there is nothing to run against yet", () => {
		let ran = false;
		plugins.use(() => {
			ran = true;
		});
		expect(plugins.size).toBe(1);
		expect(ran).toBe(false);
	});

	it("refuses a non-function at the call site, not at the first render", () => {
		// The mistake belongs to whoever called `use`, and a render is a long way
		// from there. Reached through a widened view of the same object rather
		// than a cast: the point is what a JavaScript caller can do.
		const loose: { use(plugin: unknown): unknown } = plugins;
		expect(() => loose.use(42)).toThrow(InkerRenderError);
		expect(plugins.size).toBe(0);
	});

	it("chains", () => {
		expect(plugins.use(() => undefined).use(() => undefined)).toBe(plugins);
	});
});

describe("inker > provider drains the registrar", () => {
	let tmp: string;

	beforeEach(() => {
		plugins.clear();
		resetInkerProviderFlags();
		tmp = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "inker-plugins-")),
		);
		fs.mkdirSync(path.join(tmp, "resources/templates"), { recursive: true });
	});
	afterEach(() => {
		plugins.clear();
		clearInker();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("sets usingInker in the CONSTRUCTOR, before any provider boots", () => {
		const app = mkApp(tmp);
		expect(app.usingInker).toBeUndefined();
		new InkerProvider(app);
		// Not after register(), not after start(): a package that contributes to
		// templates reads this during its own boot, which runs earlier than both.
		expect(app.usingInker).toBe(true);
	});

	it("runs a queued plugin against the engine it builds", async () => {
		const seen: boolean[] = [];
		plugins.use((engine, firstRun) => {
			seen.push(firstRun);
			engine.global("pushedByAPlugin", 42);
		});

		const app = mkApp(tmp);
		const provider = new InkerProvider(app);
		provider.register();
		await provider.start();

		// Still deferred after start(): the engine runs its plugins just before
		// the first render, exactly as a plugin registered on it directly.
		expect(seen).toHaveLength(0);

		const engine = await engineOf(app);
		engine.createRenderer();

		expect(seen).toEqual([true]);
		expect(engine.globals.get("pushedByAPlugin")).toBe(42);
	});

	it("keeps the queue so a second application gets the same plugins", async () => {
		let engines = 0;
		plugins.use(() => {
			engines += 1;
		});

		for (const _ of [0, 1]) {
			const app = mkApp(tmp);
			const provider = new InkerProvider(app);
			provider.register();
			await provider.start();
			(await engineOf(app)).createRenderer();
		}

		// Two applications in one process — parallel tests, a hot reload. The
		// registrar is process-wide, so the first must not empty it for the
		// second.
		expect(engines).toBe(2);
	});
});

describe("inker > share().render() on the module singleton", () => {
	let tmp: string;

	beforeEach(() => {
		plugins.clear();
		resetInkerProviderFlags();
		tmp = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "inker-share-")),
		);
		const views = path.join(tmp, "resources/templates");
		fs.mkdirSync(path.join(views, "components"), { recursive: true });
		fs.writeFileSync(
			path.join(views, "mail.inker"),
			"{{ greeting }} {{ name }}|@!component('sig')",
		);
		fs.writeFileSync(
			path.join(views, "components/sig.inker"),
			"[{{ greeting }}]",
		);
	});
	afterEach(() => {
		plugins.clear();
		clearInker();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("renders with the engine the provider built, as Adonis mail does with edge.share()", async () => {
		const provider = new InkerProvider(mkApp(tmp));
		provider.register();
		await provider.start();

		// Shared values reach components; per-call data stays with the template.
		expect(
			await inkerDefault
				.share({ greeting: "Hi" })
				.render("mail", { name: "Ada" }),
		).toBe("Hi Ada|[Hi]");
		// Each share() is its own renderer: nothing leaks into the next one.
		expect(
			await inkerDefault
				.share({})
				.render("mail", { greeting: "Yo", name: "B" }),
		).toBe("Yo B|[]");
	});

	it("throws a typed error when no provider has built an engine", async () => {
		await expect(
			inkerDefault.share({ greeting: "Hi" }).render("mail", {}),
		).rejects.toMatchObject({ code: "E_INKER_ENGINE_MISSING" });
	});

	it("refuses shared state that is not an object", () => {
		expect(() => inkerDefault.share(asTyped(null))).toThrow(InkerRenderError);
	});
});
