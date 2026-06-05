import type { SafeString } from "./SafeString.js";

/**
 * A caller-registered template helper. Receives the in-scope-evaluated
 * argument values and returns a string (HTML-escaped by the renderer) or a
 * `SafeString` (emitted verbatim). Re-homed here from the deleted `render.ts`
 * when the lex/parse/render hot path moved to the Rust engine (Story 55.1).
 *
 * NOTE (55.1): argument values are evaluated in the Rust engine and cross the
 * NAPI boundary as JSON, so they are JSON-coerced before reaching the helper:
 * a `Date` arrives as a string, a `bigint` as a (possibly lossy) number, and
 * `NaN` / `±Infinity` as `null`. Pass pre-stringified values for any type that
 * does not survive JSON if the helper needs the original form.
 */
export type HelperFn = (...args: readonly unknown[]) => string | SafeString;

/**
 * Signature for the canonical `t(key, params?)` helper.
 *
 * Inker ships ZERO body for this helper — implementations come from
 * the caller via `TemplatesOptions.helpers`. The Ream provider (Story
 * 53.5) wires this signature to `@c9up/rosetta`'s `Rosetta#t(key,
 * params?, options?)`.
 */
export type THelper = (key: string, params?: Record<string, unknown>) => string;

/**
 * Signature for the canonical `csrfField()` helper.
 *
 * Returns a `SafeString` containing the `<input type="hidden"
 * name="_csrf" value="…">` element. Returning a `SafeString` is
 * mandatory — a plain string would be HTML-escaped by the renderer
 * and the resulting `&lt;input …&gt;` would not be a usable form
 * field. Implementation is provided by the Ream provider (Story 53.5)
 * wiring the session's CSRF token.
 */
export type CsrfFieldHelper = () => SafeString;

/**
 * Signature for the canonical `url(name, params?)` helper.
 *
 * Resolves a named route + interpolates path params. Implementation
 * is provided by the Ream provider (Story 53.5) wiring the router.
 */
export type UrlHelper = (
	name: string,
	params?: Record<string, unknown>,
) => string;

/**
 * Signature for the canonical `asset(name)` helper.
 *
 * Resolves an asset manifest entry to its hashed public URL.
 * Implementation is provided by the Ream provider (Story 53.5) wiring
 * the asset manifest.
 */
export type AssetHelper = (name: string) => string;
