/**
 * Teach ream's `ContainerBindings` what `container.make(...)` returns for the
 * tokens inker binds.
 *
 * ream declares that interface open on purpose: it registers its own entries
 * and expects each package to contribute the ones it owns. Nothing filled
 * these in, so resolving by the string token answered `unknown` and every call
 * site had to assert a type it could not prove.
 *
 * Loaded from the package barrel, so importing Inker anywhere in the
 * application is enough — nobody writes a `declare module` of their own.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import, and a `declare module` for a specifier that does not resolve is
 * simply inert.
 */

// Referenced so the augmentations below resolve the modules they augment.
import type {} from "@c9up/ream";
import type {} from "@c9up/ream/types";

import type { InkerRenderer } from "./InkerRenderer.js";
import type { TemplateRenderer } from "./Templates.js";

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/** The template renderer, bound by `InkerProvider`. */
		inker: InkerRenderer;
	}
}

declare module "@c9up/ream" {
	interface HttpContext {
		/**
		 * A template renderer for THIS request — `ctx.view.render(name, data)`.
		 *
		 * `InkerProvider.start()` installs it as a context getter, seeded with
		 * the request, so a controller renders without threading anything. The
		 * property existed at run time and not for the compiler: every
		 * `ctx.view.render(...)` was a type error in an application that had done
		 * nothing wrong.
		 *
		 * Not optional, unlike a middleware-attached property: the provider
		 * installs the getter on the context class itself, so an application that
		 * registered inker has it on every request.
		 */
		view: TemplateRenderer;
	}
}
