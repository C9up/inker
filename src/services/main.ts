/**
 * Default `InkerRenderer` singleton — Adonis-style:
 *
 *   import inker from '@c9up/inker/provider/services/main'
 *
 *   await inker.render(ctx, 'invoice', { user })
 *
 * Populated by `InkerProvider.start()` (registered via reamrc.ts) or by the
 * app itself via `setInker(myRenderer)`.
 */

import type { InkerRenderer } from "../InkerRenderer.js";

let instance: InkerRenderer | undefined;

/**
 * @internal Bind (or clear) the singleton. Called by InkerProvider.start() to
 * wire the renderer, or by tests passing `undefined` to reset between cases
 * (the type field already permits `undefined`, so the signature mirrors it
 * honestly rather than requiring a `bypassTypeCheck` cast at every call site).
 */
export function setInker(renderer: InkerRenderer | undefined): void {
	instance = renderer;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getInker(): InkerRenderer | undefined {
	return instance;
}

// Sanctioned `as InkerRenderer` site — typed-Proxy idiom shared by
// station/rosetta/aurora/inker `services/main.ts`. Every property access is
// guarded by the `instance` check below, so the cast is structural and
// bounded. DNR `feedback_no_any_types` documents this as one of two
// permitted `as` patterns alongside `loadBearingCast` in `InkerProvider.ts`.
const inker: InkerRenderer = new Proxy({} as InkerRenderer, {
	get(_target, prop) {
		// A module loader inspects what it imports before anyone uses it: it reads
		// `then` to decide whether the namespace is thenable, and various symbols
		// for interop and formatting. Throwing on those turns a plain
		// `import { setX } from ".../services/main"` into a crash at import time,
		// far from any real use. They are not members of what this stands in for,
		// so answer undefined and let a genuine access be the one that reports.
		if (typeof prop === "symbol" || prop === "then") {
			return undefined;
		}
		// Short-circuit the thenable probe: an accidental `await mod.default`
		// (or `Promise.resolve(mod.default)`) would otherwise trigger our
		// pre-boot throw inside the await machinery and surface a confusing
		// rejected Promise. Returning `undefined` makes the value plainly
		// non-thenable, so the caller's await resolves immediately to the
		// Proxy itself — subsequent real property access still throws.
		if (prop === "then") return undefined;
		if (!instance) {
			throw new Error(
				"[inker] InkerRenderer singleton accessed before InkerProvider.start() ran " +
					"or `setInker(myRenderer)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(instance, prop, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default inker;
