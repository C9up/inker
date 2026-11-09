/**
 * The engine you push a plugin into, before there is an engine.
 *
 *   import inker from '@c9up/inker'
 *
 *   inker.use(myPlugin)
 *
 * This is how a package contributes globals or tags to templates — rosetta
 * pushing `t()`, `getDefaultLocale()` and the rest — and it is deliberately
 * NOT a container binding.
 *
 * ## Why not the container
 *
 * A contributing package used to resolve the `'inker'` token during its own
 * `boot()`. That token is bound in `register()` and only resolvable after
 * `start()` — which the lifecycle runs after every provider's `boot()` — so
 * the resolve either threw or, worse, forced the engine to be built before
 * its peers were wired. Boot order became the contract, and a second package
 * wanting to contribute would have had to be ordered by hand.
 *
 * Upstream does not have this problem because its template engine is a module
 * singleton created at import time, whose `use()` only ENQUEUES: plugins run
 * once, just before the first render. A contributor pushes whenever it likes
 * and the engine observes itself as it ends up, not as it was mid-boot.
 *
 * ## The one deviation, and why
 *
 * The singleton here is this registrar, not the engine itself. A
 * {@link Templates} takes its root at construction because the root is a
 * CONTAINMENT boundary — every path a template resolves is checked against
 * it — and an engine created at import time would have no root to be
 * contained by. So the queue lives here and {@link InkerProvider} drains it
 * into the engine it builds, where the plugins keep the deferral they would
 * have had upstream: `Templates#use` enqueues too, and the whole queue fires
 * just before the first render.
 *
 * The contract a caller sees is therefore unchanged — `use()` works at any
 * point in the lifecycle, and the plugin runs before anything renders.
 */

import { InkerRenderError } from "./InkerRenderError.js";
import type {
	InkerPluginFn,
	InkerPluginOptions,
	Templates,
} from "./Templates.js";

interface QueuedPlugin {
	readonly apply: (templates: Templates) => void;
}

/** What `share()` hands back: a render bound to the shared state. */
export interface InkerSharedRenderer {
	render(
		template: string,
		data?: Readonly<Record<string, unknown>>,
	): Promise<string>;
}

class InkerPlugins {
	readonly #queued: QueuedPlugin[] = [];
	/** The engine the provider built, once it has. */
	#engine: Templates | undefined;

	/**
	 * Register a plugin against every engine this process builds.
	 *
	 * Rejects a non-function here rather than at the first render: the mistake
	 * belongs to the call site, and a render is a long way from it.
	 */
	use<T extends InkerPluginOptions>(
		plugin: InkerPluginFn<T>,
		options?: T,
	): this {
		if (typeof plugin !== "function") {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Plugin must be a function; got ${typeof plugin}`,
			);
		}
		this.#queued.push({
			apply: (templates) => {
				templates.use(plugin, options);
			},
		});
		return this;
	}

	/** What is queued, for a test that wants to assert without rendering. */
	get size(): number {
		return this.#queued.length;
	}

	/**
	 * @internal Hand the queue to an engine. Called by `InkerProvider.start()`.
	 *
	 * The queue is NOT consumed: a process can hold more than one application —
	 * parallel tests, a hot reload — and the second engine needs the same
	 * plugins the first got. What that costs is what it costs upstream, where
	 * the singleton is equally process-wide: a plugin closing over the first
	 * application's state reaches the second one's engine too. {@link clear} is
	 * how a test resets between cases.
	 */
	applyTo(templates: Templates): void {
		for (const plugin of this.#queued) plugin.apply(templates);
	}

	/**
	 * @internal Remember the engine the provider built, so the singleton can
	 * render with it. Called by `InkerProvider.start()`; a later application
	 * in the same process replaces it.
	 */
	attach(templates: Templates): void {
		this.#engine = templates;
	}

	/**
	 * Render with shared state, outside any request (Edge `edge.share(state)`).
	 * This is what a mailer needs — AdonisJS's mail sets
	 * `Message.templateEngine` to `edge.share(helpers).render(template, data)`:
	 *
	 *   const inker = await import('@c9up/inker')
	 *   await inker.default.share(sharedState).render('emails/welcome', data)
	 *
	 * Shared values reach partials and components; `data` stays with the
	 * template. The engine is looked up when `render` runs, so a renderer
	 * shared during boot works once the provider has started.
	 */
	share(state: Readonly<Record<string, unknown>>): InkerSharedRenderer {
		if (typeof state !== "object" || state === null || Array.isArray(state)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`share() expects an object; got ${state === null ? "null" : typeof state}`,
			);
		}
		return {
			render: async (template, data = {}) => {
				const engine = this.#engine;
				if (engine === undefined) {
					throw new InkerRenderError(
						"E_INKER_ENGINE_MISSING",
						`Cannot render '${template}': no template engine has been built yet — register InkerProvider and let it start before rendering through the inker singleton`,
					);
				}
				return engine.share(state).render(template, data);
			},
		};
	}

	/** @internal Drop the queue and the engine. For tests that build several applications. */
	clear(): void {
		this.#queued.length = 0;
		this.#engine = undefined;
	}
}

/**
 * The process-wide registrar. Named as well as default-exported so a test can
 * reach {@link InkerPlugins.clear} without the default import reading as magic.
 */
export const plugins = new InkerPlugins();

export default plugins;
