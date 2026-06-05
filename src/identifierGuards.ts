/**
 * Identifier denylists shared between `parseBlockTag.ts` (each-binding +
 * component-arg-key validation) and `parseExpression.ts` (object-literal
 * key validation).
 *
 * `PROTOTYPE_POLLUTION_KEYS` blocks the three keys whose own-property
 * assignment can shadow `Object.prototype` methods or invoke
 * `Object.create` semantics in surprising ways. The gate is
 * defence-in-depth: JavaScript's `obj[key] = value` semantics make
 * `__proto__` non-exploitable when used via square brackets on a
 * non-frozen object built via `Object.create(null)`, but template
 * authors cannot reason about the renderer's storage shape and the
 * cost of the guard is one Set membership check per object key.
 *
 * `RESERVED_BINDING_NAMES` blocks identifiers that would collide with
 * Inker grammar keywords (e.g. `as`) or JavaScript reserved words when
 * used as `{% each items as <name> %}` bindings or `{% each items as
 * [<a>, <b>] %}` destructured names. The block is per-position rather
 * than universal — Inker permits these names inside path expressions
 * since paths cannot collide with the grammar.
 */
export const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

export const RESERVED_BINDING_NAMES: ReadonlySet<string> = new Set([
	"as",
	"if",
	"else",
	"each",
	"do",
	"for",
	"while",
	"let",
	"const",
	"var",
	"return",
	"function",
	"class",
	"new",
	"this",
	"super",
	"null",
	"undefined",
	"true",
	"false",
]);
