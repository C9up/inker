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

class InkerPlugins {
	readonly #queued: QueuedPlugin[] = [];

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

	/** @internal Drop the queue. For tests that build several applications. */
	clear(): void {
		this.#queued.length = 0;
	}
}

/**
 * The process-wide registrar. Named as well as default-exported so a test can
 * reach {@link InkerPlugins.clear} without the default import reading as magic.
 */
export const plugins = new InkerPlugins();

export default plugins;
