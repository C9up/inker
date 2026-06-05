/**
 * Default `InkerRenderer` singleton — Adonis-style:
 *
 *   import inker from '@c9up/inker/provider/services/main'
 *
 *   await inker.render(ctx, 'invoice', { user })
 *
 * Populated by `InkerProvider.start()` (registered via reamrc.ts) or by the
 * app itself via `_setInker(myRenderer)`.
 */

import type { InkerRenderer } from "../InkerRenderer.js";

let _instance: InkerRenderer | undefined;

/**
 * @internal Bind (or clear) the singleton. Called by InkerProvider.start() to
 * wire the renderer, or by tests passing `undefined` to reset between cases
 * (the type field already permits `undefined`, so the signature mirrors it
 * honestly rather than requiring a `bypassTypeCheck` cast at every call site).
 */
export function _setInker(instance: InkerRenderer | undefined): void {
	_instance = instance;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function _getInker(): InkerRenderer | undefined {
	return _instance;
}

// Sanctioned `as InkerRenderer` site — typed-Proxy idiom shared by
// station/rosetta/aurora/inker `services/main.ts`. Every property access is
// guarded by the `_instance` check below, so the cast is structural and
// bounded. DNR `feedback_no_any_types` documents this as one of two
// permitted `as` patterns alongside `loadBearingCast` in `InkerProvider.ts`.
const inker: InkerRenderer = new Proxy({} as InkerRenderer, {
	get(_target, prop) {
		// Short-circuit the thenable probe: an accidental `await mod.default`
		// (or `Promise.resolve(mod.default)`) would otherwise trigger our
		// pre-boot throw inside the await machinery and surface a confusing
		// rejected Promise. Returning `undefined` makes the value plainly
		// non-thenable, so the caller's await resolves immediately to the
		// Proxy itself — subsequent real property access still throws.
		if (prop === "then") return undefined;
		if (!_instance) {
			throw new Error(
				"[inker] InkerRenderer singleton accessed before InkerProvider.start() ran " +
					"or `_setInker(myRenderer)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(_instance, prop, _instance);
		return typeof value === "function" ? value.bind(_instance) : value;
	},
});

export default inker;
