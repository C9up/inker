import { InkerRenderError } from "./InkerRenderError.js";

/**
 * Marker class for already-escaped strings. Helpers that return
 * trusted HTML (e.g. `csrfField()` returning `<input type="hidden" …>`)
 * should return `new SafeString(html)` so the renderer emits the value
 * raw instead of double-escaping.
 *
 * Returning a `SafeString` constructed from user input is a cross-site
 * scripting bug. Restrict `SafeString` to author-controlled HTML
 * (constants, library output where escaping is already handled).
 */
export class SafeString {
	readonly value: string;
	constructor(value: string) {
		if (typeof value !== "string") {
			// Throws `InkerRenderError` (not native `TypeError`) so callers
			// handling the typed error contract uniformly catch SafeString
			// construction failures alongside every other Inker failure mode.
			throw new InkerRenderError(
				"E_INKER_INVALID_EXPRESSION",
				`SafeString requires a string; got ${typeof value}`,
			);
		}
		this.value = value;
	}
}
