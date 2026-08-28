// GENERATED FROM THE RUST — do not edit.
//
// Produced by scripts/generate-napi-types.mjs from napi-derive's type-def
// output. Editing this file by hand puts it back where it started: a
// description that can disagree with the code it describes.

/**
 * A `@include()` / `@component()` reference with its source position
 * (for circular-include error context).
 */

export interface NodeRefNapi {
	name: string;
	line: number;
	column: number;
}

/** A `{{> name }}` slot reference. */

export interface SlotRefNapi {
	name: string;
	line: number;
	column: number;
}

/** First disk-requiring node (for `renderString`'s E_INKER_DISK_REQUIRED guard). */

export interface DiskNodeRefNapi {
	kind: string;
	name: string;
}

/**
 * All metadata `Templates#compose` needs from a parsed AST in ONE call, so the
 * TS composer never walks the opaque native node tree itself.
 */

export interface ComposeInfoNapi {
	hasLayout: boolean;
	layoutName?: string;
	layoutLine?: number;
	layoutColumn?: number;
	slots: Array<SlotRefNapi>;
	partials: Array<NodeRefNapi>;
	components: Array<NodeRefNapi>;
	hasContent: boolean;
	firstDiskNode?: DiskNodeRefNapi;
}

/**
 * Opaque handle to a parsed Inker AST. The TS-side `Templates#cache` keeps
 * these instances alive; when the JS GC collects the wrapper, napi-rs drops
 * the inner `Arc` automatically (D55.1.3 — Arc + GC bridge replaces a manual
 * dispose API).
 */

export declare class InkerAst {
	/**
	 * One-shot composition metadata. Mirrors the TS-side AST-walk helpers
	 * (`findFirstSlotIn` / `hasBodySlotInNodes` / `findFirstDiskNode` /
	 * `bodyHasContent` / `collect{Partial,Component}Nodes`) so the composer
	 * stays in TS (it owns FS access) while node-tree walking stays in Rust.
	 */
	get composeInfo(): ComposeInfoNapi;
}

/**
 * Parse a template source string into an opaque `InkerAst` handle.
 *
 * `helpers_set` lists the helper names the parser should accept inside
 * `{{ name(...) }}` call positions. Names not in this set produce an
 * `E_INKER_UNKNOWN_HELPER` at parse time (no rendering required).
 *
 * `custom_tags_set` lists the runtime-registered custom-tag names (Edge
 * `registerTag`); the lexer/parser recognise `@<name>(args)` for each and emit
 * a `CustomTag` node the Node renderer resolves against its handler registry.
 * `custom_block_tags_set` is the subset registered with `block: true`: those
 * open a body closed by `@end<name>` (or self-close as `@!<name>`).
 */

export declare function parseTemplate(
	source: string,
	helpersSet: Array<string>,
	customTagsSet: Array<string>,
	customBlockTagsSet: Array<string>,
	componentTagsJson: string,
): InkerAst;

/**
 * Parse a template and return its AST as a walkable JSON string (nodes +
 * layout). This is the artifact the Node-side renderer consumes: Rust does the
 * CPU-bound lex/parse, Node evaluates expressions in V8 and renders (Edge
 * model — 62-2 pivot away from the embedded QuickJS VM). Each node carries the
 * verbatim `source` of its expressions, which the Node renderer evaluates.
 */

export declare function parseTemplateJson(
	source: string,
	helpersSet: Array<string>,
	customTagsSet: Array<string>,
	customBlockTagsSet: Array<string>,
	componentTagsJson: string,
): string;

/**
 * Serialize an already-parsed AST handle to a walkable JSON string (nodes +
 * layout) for the Node-side renderer (62-2 pivot). Reuses the cached parse —
 * no re-parse — so `Templates` keeps its disk/cache/compose machinery intact.
 */

export declare function astToJson(ast: InkerAst): string;

/** Crate version — useful for the TS-side `loadNapi.ts` startup diagnostic. */

export declare function engineVersion(): string;
