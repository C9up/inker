import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { INKER_GLOBAL_NAMES } from "./globals.js";
import type { HelperFn } from "./helpers.js";
import { InkerRenderError } from "./InkerRenderError.js";
import {
	PROTOTYPE_POLLUTION_KEYS,
	RESERVED_BINDING_NAMES,
} from "./identifierGuards.js";
import {
	getNative,
	type NapiInkerAst,
	type NapiNodeRef,
	napiThrowToInker,
} from "./loadNapi.js";
import {
	collectSections,
	type InkerNodeJson,
	type InkerTag,
	type NodeRenderContext,
	renderNodeTree,
	renderNodeTreeAsync,
} from "./renderNode.js";
import { Stacks } from "./stacks.js";

export type CacheMode = "auto" | "mtime" | "never";

/** Options a plugin is registered with. `recurring` re-runs it on every
 * render rather than only the first (Edge parity). */
export interface InkerPluginOptions {
	readonly recurring?: boolean;
}

/**
 * A plugin (Edge `PluginFn`). Receives the engine, whether this is its first
 * run, and the options it was registered with. A one-argument plugin — the
 * common shape, and what rosetta's i18n plugin is — stays valid.
 */
export type InkerPluginFn<T extends InkerPluginOptions = InkerPluginOptions> = (
	templates: Templates,
	firstRun: boolean,
	options: T | undefined,
) => void;

export interface TemplatesOptions {
	root: string;
	cacheMode?: CacheMode;
	helpers?: ReadonlyMap<string, HelperFn>;
}

const HELPER_NAME_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

// P13 — Windows-reserved device basenames. Refused on every platform for
// portability: a template named `con.inker` would resolve to the Windows
// console device handle, not a file.
const WINDOWS_RESERVED: ReadonlySet<string> = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	"com1",
	"com2",
	"com3",
	"com4",
	"com5",
	"com6",
	"com7",
	"com8",
	"com9",
	"lpt1",
	"lpt2",
	"lpt3",
	"lpt4",
	"lpt5",
	"lpt6",
	"lpt7",
	"lpt8",
	"lpt9",
]);

interface CacheEntry {
	ast: NapiInkerAst;
	mtimeMs: number;
}

interface ComposedTemplate {
	bodyAst: NapiInkerAst;
	layoutAst?: NapiInkerAst;
	layoutName?: string;
	layoutAbsPath?: string;
	partialAsts: Map<string, NapiInkerAst>;
	componentAsts: Map<string, NapiInkerAst>;
}

/** The template file extension, shared by resolution and the component scan. */
const TEMPLATE_EXT = ".inker";

/** A component tag name: dot-separated camelCase segments (`form.input`). */
const COMPONENT_TAG_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;

/** camelCase one path segment for a component tag (`my-button` → `myButton`). */
function camelCaseSegment(segment: string): string {
	return segment
		.split(/[-_\s]+/)
		.filter((w) => w.length > 0)
		.map((w, i) =>
			i === 0
				? w.charAt(0).toLowerCase() + w.slice(1)
				: w.charAt(0).toUpperCase() + w.slice(1),
		)
		.join("");
}

const VALID_CACHE_MODES: ReadonlySet<string> = new Set([
	"auto",
	"mtime",
	"never",
]);

/** Validate a requested cache mode and resolve `auto` against the environment.
 * Shared by the constructor and `configure()` so both apply the same rules. */
function resolveCacheMode(requested: CacheMode): "mtime" | "never" {
	if (!VALID_CACHE_MODES.has(requested)) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Templates cacheMode must be one of 'auto' | 'mtime' | 'never'; got ${JSON.stringify(requested)}`,
		);
	}
	if (requested === "auto") {
		return process.env.NODE_ENV === "production" ? "never" : "mtime";
	}
	return requested;
}

// Built-in block/directive keywords a custom tag may not shadow (registerTag).
// The parser already ignores these as custom tags; rejecting them here makes the
// collision loud instead of silently inert.
// MUST mirror the lexer's `is_block_keyword` set (crates/inker-engine/src/lex.rs)
// exactly — a name the lexer treats as a built-in but that is missing here would
// pass registration and then sit silently inert (its `@name` never becomes a
// CustomTag node), the very failure this blocklist exists to make loud.
const RESERVED_TAG_NAMES: ReadonlySet<string> = new Set([
	"if",
	"elseif",
	"else",
	"endif",
	"unless",
	"endunless",
	"each",
	"endeach",
	"let",
	"layout",
	"include",
	"includeIf",
	"component",
	"endcomponent",
	"slot",
	"endslot",
	"section",
	"endsection",
	"super",
	"eval",
	"dump",
]);

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
	return (
		value instanceof Error && typeof Reflect.get(value, "code") === "string"
	);
}

function normalizePartialKey(name: string): string {
	let key = name;
	while (key.startsWith("./")) key = key.slice(2);
	// T2: refuse an empty key — `@include('./')` would otherwise collide
	// with the synthetic `<root>/.inker` dotfile path and silently include
	// (or misreport) an unrelated file. validateName lets a literal `./`
	// through (no `..`, no NUL, no backslash, length > 0), so the assertion
	// must live here.
	if (key.length === 0) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Partial/component name resolves to an empty key; got ${JSON.stringify(name)}`,
			{ templateName: name },
		);
	}
	return key;
}

function validateName(name: unknown): string {
	if (typeof name !== "string" || name.length === 0) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Template name must be a non-empty string; got ${JSON.stringify(name)}`,
			{ templateName: typeof name === "string" ? name : undefined },
		);
	}
	assertSafeCharacters(name);
	assertSafePathShape(name);
	assertNotReservedDeviceName(name);
	return name;
}

/**
 * Reject NUL, other control bytes (CR/LF/TAB/ESC etc.), the BOM, and lone
 * surrogates. These pass through filesystems differently across platforms
 * (ext4 vs NTFS), corrupt JSON serialisation of error context, and amplify
 * ANSI-escape injection into messages that interpolate `templatePath`.
 */
function assertSafeCharacters(name: string): void {
	if (name.includes("\0")) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			"Template name contains a NUL byte",
			{ templateName: name },
		);
	}
	for (let i = 0; i < name.length; i += 1) {
		const code = name.charCodeAt(i);
		// C0 controls (0x00 caught above), DEL, C1 controls
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Template name contains a control character (0x${code.toString(16).padStart(2, "0")}) at offset ${i}; got ${JSON.stringify(name)}`,
				{ templateName: name },
			);
		}
		if (code === 0xfeff) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Template name contains a BOM (U+FEFF) at offset ${i}`,
				{ templateName: name },
			);
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = name.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new InkerRenderError(
					"E_INKER_INVALID_PATH",
					`Template name contains a lone high surrogate at offset ${i}`,
					{ templateName: name },
				);
			}
			i += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Template name contains a lone low surrogate at offset ${i}`,
				{ templateName: name },
			);
		}
	}
}

/**
 * Reject absolute paths, `..` segments, backslashes, and Windows drive-letter
 * prefixes — each would bypass the lexical `path.join(root, …)` containment.
 * Mirrors parseBlockTag.validatePathName so `@include()` and the public
 * Templates#render entrypoint agree.
 */
function assertSafePathShape(name: string): void {
	if (path.isAbsolute(name)) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Template name must be relative to the templates root; got absolute path ${JSON.stringify(name)}`,
			{ templateName: name },
		);
	}
	if (name.split(/[/\\]/).some((segment) => segment === "..")) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Template name cannot contain '..' segments; got ${JSON.stringify(name)}`,
			{ templateName: name },
		);
	}
	if (name.includes("\\")) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Template name cannot contain backslashes (use forward slash only); got ${JSON.stringify(name)}`,
			{ templateName: name },
		);
	}
	if (/^[A-Za-z]:/.test(name)) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Template name cannot start with a Windows drive-letter prefix; got ${JSON.stringify(name)}`,
			{ templateName: name },
		);
	}
	// A bare (post-`#splitDisk`) template name never legitimately contains `:`.
	// The drive-letter guard above only catches a leading `[A-Za-z]:`; a residual
	// separator such as `1::b` (digit-led, so it slips that guard) would otherwise
	// reach `path.join` and, on Windows NTFS, be reinterpreted as an alternate-
	// data-stream reference — a cross-platform resolution divergence. `:` is
	// already reserved as the `::` disk separator, so forbid it outright here.
	if (name.includes(":")) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Template name cannot contain ':' characters; got ${JSON.stringify(name)}`,
			{ templateName: name },
		);
	}
}

/**
 * Refuse Windows-reserved basenames (`con`, `prn`, `aux`, `nul`, `com1`-`com9`,
 * `lpt1`-`lpt9`) on all platforms — they resolve to device handles on Windows
 * and throw opaque non-Inker errors, so a template that works on Linux would
 * fail mysteriously there.
 */
function assertNotReservedDeviceName(name: string): void {
	for (const segment of name.split("/")) {
		const base = segment.replace(/\.[^.]*$/, "").toLowerCase();
		if (WINDOWS_RESERVED.has(base)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Template name segment '${segment}' is a Windows-reserved device name`,
				{ templateName: name },
			);
		}
	}
}

/**
 * Validate a mount disk name (AdonisJS/Edge `edge.mount(name, …)` parity).
 * A disk name is an identifier-shaped label, NOT a path: it must be non-empty
 * and contain only `[A-Za-z0-9_-]`. This forbids `::` (the disk separator),
 * `/` and `\` (path segments), `.`/`..` traversal, and control bytes — a disk
 * name can never itself become a path component that widens containment.
 */
const DISK_NAME_RE = /^[A-Za-z0-9_-]+$/;
function assertDiskName(diskName: unknown): void {
	if (typeof diskName !== "string" || !DISK_NAME_RE.test(diskName)) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Mount disk name must match ${DISK_NAME_RE} (identifier-shaped, no path separators); got ${JSON.stringify(diskName)}`,
			{ templateName: typeof diskName === "string" ? diskName : undefined },
		);
	}
}

function assertContained(root: string, absPath: string, name: string): void {
	// P12: case-sensitive `startsWith` breaks on APFS/HFS+/NTFS where
	// `realpath` canonicalises segment casing — a root like
	// `/Users/x/Templates` whose realpath returns `/users/x/templates`
	// would fail every legitimate lookup. Switch to `path.relative`:
	// when the target is under root, the relative path neither starts
	// with `..` nor is absolute (Windows cross-drive case).
	const normalised = path.resolve(absPath);
	const rel = path.relative(root, normalised);
	if (rel === "") return; // identical path
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Resolved template path escapes the templates root: ${normalised} is outside ${root}`,
			{ templatePath: normalised, templateName: name },
		);
	}
}

function wrapFsError(
	cause: unknown,
	absPath: string,
	name: string,
): InkerRenderError {
	if (isErrnoException(cause) && cause.code === "ENOENT") {
		return new InkerRenderError(
			"E_INKER_TEMPLATE_NOT_FOUND",
			`Template not found: ${absPath}`,
			{ templatePath: absPath, templateName: name },
			{ cause },
		);
	}
	if (isErrnoException(cause)) {
		// EACCES / EISDIR / ELOOP / ENOTDIR — file exists but the path does
		// not resolve to a readable regular file. Path-axis error, not
		// missing-template.
		return new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Template path is not a readable file (${cause.code}): ${absPath}`,
			{ templatePath: absPath, templateName: name },
			{ cause },
		);
	}
	// Non-Errno failure (e.g. unexpected runtime error during stat/read) —
	// don't lie about "template not found" since the file may well exist;
	// surface as a generic path-axis failure with the underlying message.
	const detail = cause instanceof Error ? cause.message : String(cause);
	return new InkerRenderError(
		"E_INKER_INVALID_PATH",
		`Failed to load template ${absPath}: ${detail}`,
		{ templatePath: absPath, templateName: name },
		{ cause },
	);
}

// Run a native (NAPI) call and translate any thrown `napi::Error` carrying the
// engine's JSON error envelope back into a typed `InkerRenderError` (preserving
// code / line / column / templateName). Without this, the raw napi error
// surfaces with `code === "GenericFailure"`.
function callNative<T>(fn: () => T): T {
	try {
		return fn();
	} catch (err) {
		throw napiThrowToInker(err);
	}
}

// JS `Map` / `Set` instances do not cross the NAPI boundary as serde_json
// values (a Map serialises to `{}`), so the renderer would see them as empty.
// Encode them into the array-of-pairs / array-of-values shapes the Rust
// renderer's destructured-`each` iteration expects (mirrors the pre-Rust TS
// renderer's `Map.entries()` / `Set` iteration). Plain objects and arrays are
// recursed (to catch nested Maps); Dates / class instances pass through so
// napi-rs serialises them as it did before.
// Guard against circular references: the Rust engine serialises the entire data
// tree across the NAPI boundary, so a cycle would otherwise overflow the stack
// here (or fail opaquely at the serde boundary). Surface a clear, catchable
// error instead. `seen` tracks the current ancestor chain (added on entry,
// removed on exit) so shared-but-acyclic subgraphs (a DAG) are not false-flagged.
function enterCycleGuard(value: object, seen: WeakSet<object>): void {
	if (seen.has(value)) {
		throw new InkerRenderError(
			"E_INKER_INVALID_EXPRESSION",
			"render data contains a circular reference — Inker serialises the full data tree to the Rust engine and cannot encode cyclic structures",
		);
	}
	seen.add(value);
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

function encodeData(
	value: unknown,
	seen: WeakSet<object> = new WeakSet(),
): unknown {
	if (value === undefined) {
		// An explicit `undefined` own-property is silently dropped by JSON
		// encoding, after which the Rust engine treats the key as missing and
		// throws E_INKER_UNKNOWN_IDENTIFIER. The pre-Rust TS engine rendered null
		// and undefined identically (empty string, falsy). Normalise undefined to
		// null to preserve that behavior; the engine already maps the `undefined`
		// literal to null too.
		return null;
	}
	if (value instanceof Map) return encodeMap(value, seen);
	if (value instanceof Set) return encodeSet(value, seen);
	if (Array.isArray(value)) return encodeArray(value, seen);
	if (value !== null && typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto === Object.prototype || proto === null) {
			return encodePlainObject(value, seen);
		}
		// Date, class instance, etc. — let napi-rs serialise as before.
		return value;
	}
	if (typeof value === "bigint") return encodeBigInt(value);
	if (typeof value === "number" && !Number.isFinite(value)) {
		// NaN / ±Infinity have no JSON representation (serde encodes them as null,
		// which would render as empty). The pre-Rust TS engine rendered the literal
		// "NaN" / "Infinity"; that is unreachable through the JSON boundary, so fail
		// loudly instead of rendering empty.
		throw new InkerRenderError(
			"E_INKER_INVALID_EXPRESSION",
			`Cannot pass non-finite number ${value} as template data — NaN and Infinity have no representation across the engine boundary; format it via a helper before rendering`,
		);
	}
	return value;
}

function encodeMap(
	value: Map<unknown, unknown>,
	seen: WeakSet<object>,
): unknown[] {
	enterCycleGuard(value, seen);
	const out = Array.from(value, ([k, v]) => [
		encodeData(k, seen),
		encodeData(v, seen),
	]);
	seen.delete(value);
	return out;
}

function encodeSet(value: Set<unknown>, seen: WeakSet<object>): unknown[] {
	enterCycleGuard(value, seen);
	const out = Array.from(value, (v) => encodeData(v, seen));
	seen.delete(value);
	return out;
}

/**
 * Structural sharing: only allocate a new array if a descendant actually
 * changed (a Map/Set was encoded). The common Map/Set-free data tree is
 * returned by reference, avoiding a full deep clone on every render.
 */
function encodeArray(value: unknown[], seen: WeakSet<object>): unknown {
	enterCycleGuard(value, seen);
	let changed = false;
	const out: unknown[] = new Array(value.length);
	for (let i = 0; i < value.length; i++) {
		// Sparse holes survive JSON encoding as `null`, which the Rust engine
		// would silently iterate/index. The pre-Rust TS engine rejected holes
		// with a typed error; restore that here (eager, since the hole is only
		// visible JS-side — slightly stricter than the old lazy check, which
		// only fired when the hole was actually iterated or indexed).
		if (!(i in value)) {
			seen.delete(value);
			throw new InkerRenderError(
				"E_INKER_INVALID_ITERABLE",
				`Sparse array hole at index ${i} — Inker does not support sparse arrays; fill holes with explicit values`,
			);
		}
		const encoded = encodeData(value[i], seen);
		if (encoded !== value[i]) changed = true;
		out[i] = encoded;
	}
	seen.delete(value);
	return changed ? out : value;
}

/** Encode a plain object's own entries, sharing the reference when unchanged. */
function encodePlainObject(value: object, seen: WeakSet<object>): unknown {
	enterCycleGuard(value, seen);
	let changed = false;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		const encoded = encodeData(v, seen);
		if (encoded !== v) changed = true;
		out[k] = encoded;
	}
	seen.delete(value);
	return changed ? out : value;
}

/**
 * `bigint` cannot cross the NAPI boundary (serde JSON has no bigint). Widen to
 * `Number` when it round-trips exactly; refuse the lossy case rather than
 * silently dropping precision (the pre-Rust TS engine used `String(value)`).
 */
function encodeBigInt(value: bigint): number {
	if (value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) {
		return Number(value);
	}
	throw new InkerRenderError(
		"E_INKER_INVALID_EXPRESSION",
		`Cannot pass bigint ${value} as template data — it exceeds Number.MAX_SAFE_INTEGER and cannot cross the engine boundary without precision loss; convert it to a string via a helper or a precomputed field`,
	);
}

/**
 * Validate `options.root` and return its canonical (realpath'd) absolute path.
 * Refuses non-absolute, filesystem/drive-root, missing, non-directory, and
 * non-canonicalisable roots — each would break the symlink-containment guard
 * in #loadAst.
 */
function canonicalizeTemplatesRoot(root: unknown): string {
	if (typeof root !== "string" || !path.isAbsolute(root)) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Templates root must be an absolute path; got ${JSON.stringify(root)}`,
			{ templatePath: typeof root === "string" ? root : undefined },
		);
	}

	// D3: refuse filesystem-root / drive-root values. With root = "/" on
	// POSIX or "C:\" on Windows, assertContained's `startsWith(rootWithSep)`
	// matches every absolute path and the symlink-containment guard
	// degenerates to "anywhere on the volume". Operator misconfiguration —
	// fail loudly at construction rather than serve traversal as a feature.
	if (root === "/" || /^[A-Za-z]:[\\/]?$/.test(root)) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Templates root cannot be the filesystem/drive root; got ${JSON.stringify(root)}`,
			{ templatePath: root },
		);
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(root);
	} catch (cause) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Templates root does not exist: ${root}`,
			{ templatePath: root },
			{ cause },
		);
	}

	if (!stat.isDirectory()) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Templates root is not a directory: ${root}`,
			{ templatePath: root },
		);
	}

	// Canonicalize root via realpath so symlinked-target containment checks
	// compare canonical-against-canonical paths in #loadAst.
	// P6: realpath failure here is a hard error — `statSync(root)` succeeded
	// two lines up, so realpath should not fail. Silently falling back to
	// the un-canonical root caused the realpath containment check in
	// #loadAst to compare a real-path against a possibly-symlinked root,
	// producing false positives (legitimate templates rejected) for every
	// caller — broken Inker without diagnostic.
	try {
		// `.native` (the OS realpath) so the root and per-template realpath in
		// #loadAst use the SAME canonical form — on Windows it expands 8.3 short
		// names (RUNNER~1 -> runneradmin) that JS-side realpath leaves as-is,
		// which otherwise breaks the symlink-containment check on CI runners.
		return fs.realpathSync.native(root);
	} catch (cause) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Templates root could not be canonicalised (realpath failed) although it exists: ${root}`,
			{ templatePath: root },
			{ cause },
		);
	}
}

/**
 * Validate the helper registry and return it alongside the frozen set of helper
 * names used for parse-time validation. Rejects non-Map containers, non-string
 * keys, non-callable values, invalid identifiers, reserved words, and
 * prototype-pollution keys.
 */
function validateHelpers(
	rawHelpers: ReadonlyMap<string, HelperFn> | undefined,
): {
	helpers: ReadonlyMap<string, HelperFn>;
	helperNames: Set<string>;
} {
	const helpers = rawHelpers ?? new Map<string, HelperFn>();
	// P12 — validate the helpers container is actually a Map. The TS type
	// promises ReadonlyMap, but a caller in plain JS (or via a typed bypass)
	// could pass a plain object and hit a confusing "helpers.keys is not a
	// function" at construction.
	if (!(helpers instanceof Map)) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Templates.helpers must be a Map; got ${Object.prototype.toString.call(helpers).slice(8, -1)}`,
		);
	}
	const helperNames = new Set<string>(INKER_GLOBAL_NAMES);
	for (const [key, value] of helpers) {
		// T3: validate the key is a string BEFORE handing it to
		// HELPER_NAME_RE.test(), which ToString-coerces and throws a raw
		// TypeError for Symbol keys — leaking outside the typed-error
		// contract. Map allows any key type at runtime; only strings make
		// sense as helper names.
		if (typeof key !== "string") {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Helper name must be a string; got ${typeof key}`,
			);
		}
		// P13 — validate each helper value is callable. Without this, a
		// non-function would surface as a generic TypeError wrapped under
		// E_INKER_HELPER_THROW at render-time, hiding the registration bug.
		if (typeof value !== "function") {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Helper '${key}' must be a function; got ${typeof value}`,
				{ templateName: key },
			);
		}
		if (!HELPER_NAME_RE.test(key)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Helper name '${key}' is not a valid identifier (must match /^[a-zA-Z_$][a-zA-Z0-9_$]*$/)`,
				{ templateName: key },
			);
		}
		if (RESERVED_BINDING_NAMES.has(key)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Helper name '${key}' is a reserved word`,
				{ templateName: key },
			);
		}
		if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Helper name '${key}' is forbidden (prototype-pollution surface)`,
				{ templateName: key },
			);
		}
		helperNames.add(key);
	}
	return { helpers, helperNames };
}

/** The value handed to a `raw` processor: a template's source before parsing. */
export interface RawProcessorValue {
	readonly raw: string;
	/** Absolute path, when the source came from disk. */
	readonly path?: string;
}

/** The value handed to an `output` processor: rendered HTML. */
export interface OutputProcessorValue {
	readonly output: string;
	/** Template name, when the render started from one. */
	readonly template?: string;
}

/**
 * Source and output transforms (Edge `edge.processor`).
 *
 * INKER DEVIATION (named): Edge also exposes a `compiled` stage that rewrites
 * the JavaScript its compiler emits. Inker has no such stage — templates parse
 * to an AST in Rust and render by walking it, so there is no intermediate code
 * to rewrite. Registering `compiled` throws rather than sitting silently inert.
 */
export class Processor {
	readonly #raw: Array<(value: RawProcessorValue) => string | undefined> = [];
	readonly #output: Array<(value: OutputProcessorValue) => string | undefined> =
		[];
	readonly #onRawRegistered: () => void;

	constructor(onRawRegistered: () => void) {
		this.#onRawRegistered = onRawRegistered;
	}

	process(
		stage: "raw",
		fn: (value: RawProcessorValue) => string | undefined,
	): void;
	process(
		stage: "output",
		fn: (value: OutputProcessorValue) => string | undefined,
	): void;
	// The overloads above are what callers see, and they give the callback its
	// parameter type. The implementation signature takes the INTERSECTION of the
	// two handler types: a value of that type is assignable to either registry,
	// so the dispatch below needs no cast.
	process(
		stage: "raw" | "output",
		fn: ((value: RawProcessorValue) => string | undefined) &
			((value: OutputProcessorValue) => string | undefined),
	): void {
		if (typeof fn !== "function") {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`processor.process('${String(stage)}') — handler must be a function; got ${typeof fn}`,
			);
		}
		if (stage === "raw") {
			this.#raw.push(fn);
			this.#onRawRegistered();
			return;
		}
		if (stage === "output") {
			this.#output.push(fn);
			return;
		}
		// Unreachable from TypeScript; reachable from plain JS, and a stage that
		// never fires would be a silent no-op — so it is loud instead.
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`processor.process — unknown stage '${String(stage)}'. Inker supports 'raw' and 'output'. Edge's 'compiled' stage has no equivalent: no JavaScript is emitted, templates parse to an AST. Its 'tag' stage has none either: parsing happens in Rust, so a JS handler cannot mutate a token mid-parse — and its canonical use, exposing components as tags, is built in (see listComponents).`,
		);
	}

	/** Apply every `raw` transform in registration order. */
	applyRaw(raw: string, path?: string): string {
		let out = raw;
		// A processor returning undefined leaves the value untouched, so a
		// transform can bail out without reconstructing its input.
		for (const fn of this.#raw) {
			const next = fn({ raw: out, path });
			if (typeof next === "string") out = next;
		}
		return out;
	}

	/** Apply every `output` transform in registration order. */
	applyOutput(output: string, template?: string): string {
		let out = output;
		for (const fn of this.#output) {
			const next = fn({ output: out, template });
			if (typeof next === "string") out = next;
		}
		return out;
	}
}

/**
 * After the handle is open, confirm the file the OS actually resolved is still
 * inside `root`. `O_NOFOLLOW` already refused a symlinked final segment; this
 * catches an intermediate directory that is one.
 *
 * Extracted so the synchronous loader runs the SAME check — a second copy of a
 * containment rule is how the two paths drift apart.
 */
function assertRealpathContained(
	absPath: string,
	root: string,
	validatedName: string,
): void {
	let realPath: string;
	try {
		// `.native` to match validateRoot's canonical form (same OS realpath)
		// so 8.3-short-name / casing differences don't trip containment.
		realPath = fs.realpathSync.native(absPath);
	} catch (cause) {
		throw wrapFsError(cause, absPath, validatedName);
	}
	if (realPath === absPath) return;
	const rel = path.relative(root, realPath);
	if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			`Resolved template path escapes the templates root via symlink: ${realPath} is outside ${root}`,
			{ templatePath: realPath, templateName: validatedName },
		);
	}
}

/** One template the composition needs before it can continue. */
interface LoadRequest {
	readonly absPath: string;
	readonly validatedName: string;
	readonly root: string;
}

/**
 * A walk over the composition that ASKS for each template it needs instead of
 * loading it. Two drivers serve those requests — one with promise I/O, one with
 * the synchronous calls — so `render` and `renderSync` share ONE copy of the
 * 379 lines that decide WHAT to load. Only the loader leaves differ.
 */
// The composition only ever asks for loads, but it is delegated to from the
// render stream, so it must accept that stream's answer type; `askedForAst`
// narrows at each site.
type ComposeStep<T> = Generator<LoadRequest, T, NapiInkerAst | string>;

/** One sub-render the composition needs: a node list plus its scope. */
interface RenderRequest {
	readonly nodes: readonly InkerNodeJson[];
	readonly state: Readonly<Record<string, unknown>>;
	readonly ctx: NodeRenderContext;
}

/**
 * A whole render as a sequence of requests — templates to load and node lists
 * to render. `render` and `renderSync` differ only in how they answer them.
 */
type RenderSteps = Generator<
	LoadRequest | RenderRequest,
	string,
	// A generator carries ONE `next` type, and this stream alternates two: a
	// load is answered with an AST, a sub-render with HTML. The union is
	// narrowed at each `yield` site by `askedForAst` / `askedForHtml`, which
	// also assert the driver answered the request it was given.
	NapiInkerAst | string
>;

function askedForAst(answer: NapiInkerAst | string): NapiInkerAst {
	if (typeof answer === "string") {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			"render driver answered a template load with rendered HTML",
		);
	}
	return answer;
}

function askedForHtml(answer: NapiInkerAst | string): string {
	if (typeof answer !== "string") {
		throw new InkerRenderError(
			"E_INKER_INVALID_PATH",
			"render driver answered a sub-render with a template AST",
		);
	}
	return answer;
}

/** Shorthand so a request reads like the call it replaced. */
function loadRequest(
	absPath: string,
	validatedName: string,
	root: string,
): LoadRequest {
	return { absPath, validatedName, root };
}

/** A callable global doubles as a helper, so the parser accepts `{{ name(x) }}`
 * as a call rather than an unknown-helper error. `typeof` narrows to `Function`,
 * which carries no signature — this guard is what states the contract. */
function isHelperFn(value: unknown): value is HelperFn {
	return typeof value === "function";
}

export class Templates {
	readonly #root: string;
	// Not readonly: `configure()` can swap it on a live engine (Edge parity).
	#cacheMode: "mtime" | "never";
	/** Callbacks registered through `onRender`, run on every `createRenderer`. */
	readonly #renderCallbacks: ((renderer: TemplateRenderer) => void)[] = [];
	/** Components exposed as tags, refreshed before each render. `undefined`
	 * until the first scan. */
	#componentTags: Map<string, string> | undefined;
	/** Plugins registered through `use`, run lazily at the first render. */
	// Each entry stores an already-bound CALL rather than the raw function: the
	// plugin's option type is generic per registration, and a list of raw
	// `InkerPluginFn<T>` cannot be typed without widening `T` unsoundly.
	readonly #plugins: {
		run: (firstRun: boolean) => void;
		options: InkerPluginOptions | undefined;
		executed: boolean;
	}[] = [];
	readonly #cache: Map<string, CacheEntry> = new Map();
	readonly #inflight: Map<string, Promise<NapiInkerAst>> = new Map();
	// T7: monotonic counter bumped by clearCache(). #loadAstUncached snapshots
	// it before doing async I/O and refuses to write back to the cache if the
	// generation moved during the load — prevents a pre-clear in-flight load
	// from silently re-populating the cache after clearCache() ran.
	#cacheGeneration = 0;
	readonly #helpers: ReadonlyMap<string, HelperFn>;
	// Values shared with EVERY template (Edge `edge.global`). Kept apart from
	// `#helpers`: a helper name is handed to the Rust lexer at parse time so
	// `@name()` resolves as a call, whereas a global is plain render state and
	// must NOT change how a template parses.
	readonly #globals: Map<string, unknown> = new Map();
	// Globals whose value is callable. The Rust parser validates `{{ name(…) }}`
	// against the helper-name list handed to `parseTemplate`, so a callable global
	// must ALSO be published as a helper or the template fails to parse with
	// E_INKER_UNKNOWN_HELPER. Kept separate from `#helpers` (constructor-supplied,
	// frozen) so the composed view can be memoised and invalidated on its own.
	readonly #globalFns: Map<string, HelperFn> = new Map();
	#composedHelpers: ReadonlyMap<string, HelperFn> | undefined;
	// Source/output transforms (Edge `edge.processor.process`). INKER DEVIATION
	// (named): Edge also exposes a `compiled` stage that rewrites the JavaScript
	// its compiler emits. Inker has no such stage — templates parse to an AST in
	// Rust and render by walking it, so there is no intermediate code to rewrite.
	// Registering `compiled` therefore throws rather than silently never firing.
	// Templates registered from memory (Edge `registerTemplate`). Keyed by the
	// SAME validated name a disk lookup would produce, so `@include('x')` and
	// `@component('components/x')` resolve here before any filesystem access —
	// an in-memory template has no path, so the containment and symlink guards
	// simply never come into play for it.
	readonly #inMemory: Map<string, string> = new Map();
	/**
	 * Source and output transforms (Edge `edge.processor`). A `raw` transform
	 * changes what gets parsed, so registering one clears the AST cache.
	 */
	readonly processor: Processor = new Processor(() => {
		this.clearCache();
	});
	readonly #helperNames: ReadonlySet<string>;
	// Runtime-registered custom tags (Edge `registerTag`). Names here make the
	// parser recognise `@<tagName>(jsArg)` as a `CustomTag` node; the tag's
	// `compile` runs at render time. A LIVE map, like `#helpers` — but because
	// tag names change how a template PARSES, registerTag() invalidates the cache.
	readonly #tags: Map<string, InkerTag> = new Map();
	// Named template "disks" (AdonisJS/Edge `edge.mount(name, dir)` parity).
	// The DEFAULT disk is `#root` (the constructor `root`), addressed by a bare
	// `template` name; a NAMED disk is addressed as `name::template`. Each value
	// is a canonicalised absolute root — containment (assertContained + the
	// #loadAst symlink guard) is enforced against the disk's OWN root, never a
	// shared one, so mounting a package's templates cannot widen traversal.
	readonly #disks: Map<string, string> = new Map();

	/** Construct an engine (Edge `Edge.create`). Mirrors `new Templates(...)`. */
	static create(options: TemplatesOptions): Templates {
		return new Templates(options);
	}

	constructor(options: TemplatesOptions) {
		this.#root = canonicalizeTemplatesRoot(options.root);

		this.#cacheMode = resolveCacheMode(options.cacheMode ?? "auto");

		// P14 reverted: `Templates#helpers` is intentionally a LIVE reference,
		// documented by the `resolves helper implementation LIVE per call (D4)`
		// regression test. Parse-time validation is fixed to the helper SET
		// registered at ctor; the implementation behind each name can be swapped
		// at runtime by the caller (catalogue hot-swap), so no defensive copy.
		const { helpers, helperNames } = validateHelpers(options.helpers);
		this.#helpers = helpers;
		this.#helperNames = helperNames;
	}

	/**
	 * Mount a named templates "disk" (AdonisJS/Edge `edge.mount(name, dir)`
	 * parity). Templates in a mounted disk are addressed as `name::template`
	 * (including from `@layout()` / `@include()` / `@component()`
	 * references); a BARE `template` name always resolves against the default
	 * root, exactly like Edge. `dir` is canonicalised (absolute + realpath) the
	 * same way the constructor root is, so each disk carries its own containment
	 * boundary.
	 *
	 * Re-mounting a name to the SAME canonicalised root is an idempotent no-op;
	 * re-mounting to a DIFFERENT root throws `E_INKER_DISK_COLLISION` (call
	 * `unmount` first for an intentional replacement). This is a NAMED deviation
	 * from Edge's silent overwrite: this engine is shared process-wide and
	 * consumed by multiple integration packages, so an accidental disk-name
	 * clash must fail loud rather than silently clobber another package's
	 * containment boundary.
	 */
	mount(dir: string | URL): void;
	mount(diskName: string, dir: string | URL): void;
	mount(diskNameOrDir: string | URL, maybeDir?: string | URL): void {
		// Edge's one-argument form mounts the default disk, which is what
		// `edge.mount(new URL('./views', import.meta.url))` relies on.
		const diskName = maybeDir === undefined ? "default" : String(diskNameOrDir);
		const dir = maybeDir ?? diskNameOrDir;
		assertDiskName(diskName);
		// Edge mounts with `new URL('./views', import.meta.url)`; accept that form
		// so a directory computed from a module's own location ports unchanged.
		const root = canonicalizeTemplatesRoot(
			dir instanceof URL ? fileURLToPath(dir) : dir,
		);
		const existing = this.#disks.get(diskName);
		if (existing !== undefined && existing !== root) {
			throw new InkerRenderError(
				"E_INKER_DISK_COLLISION",
				`Disk "${diskName}" is already mounted to "${existing}"; refusing to overwrite it with "${root}". Call unmount(${JSON.stringify(diskName)}) first to replace it.`,
			);
		}
		this.#disks.set(diskName, root);
	}

	/**
	 * Unmount a named disk (AdonisJS/Edge `edge.unmount(name)` parity). No-op if
	 * the disk was never mounted. Does NOT clear the AST cache — cache keys are
	 * `(root, absPath)` pairs, so a later re-mount of a different directory
	 * resolves under a different root and cannot serve a stale entry, even when
	 * two directories canonicalise to overlapping absolute paths.
	 */
	unmount(diskName: string): void {
		this.#disks.delete(diskName);
	}

	/**
	 * Register a custom tag (AdonisJS/Edge `edge.registerTag` parity). The `tag`
	 * definition — `{ tagName, block, seekable, compile(parser, buffer, token) }` —
	 * makes the parser recognise `@<tagName>(jsArg)` in every template and emit a
	 * `CustomTag` node. At render time inker calls `compile`, whose `buffer`
	 * writes the output (`writeRaw` for verbatim markup, `outputExpression` to
	 * evaluate a template expression) and whose `token.properties.jsArg` is the
	 * verbatim argument source, e.g. an `@svg('icon')` or `@time()` tag.
	 *
	 * A tag declared `block: true` takes a body closed by `@end<tagName>` (or is
	 * self-closed as `@!<tagName>`); its `compile` reads the body through
	 * `token.renderBody()`.
	 *
	 * INKER DEVIATION (named): Edge runs `compile` once at compilation (it emits
	 * JS); inker parses in Rust and renders by walking the JSON AST, so `compile`
	 * runs at RENDER time — and a block tag therefore receives its body already
	 * rendered (`token.renderBody()`) rather than Edge's raw `token.children`
	 * lexer tokens, which have no counterpart here.
	 *
	 * Because tag names change how a template PARSES, registering (or overwriting)
	 * a tag clears the AST cache — call `registerTag` during boot, before rendering.
	 */
	registerTag(tag: InkerTag): void {
		const name = tag?.tagName;
		if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`registerTag — tagName must be a valid identifier (letters, digits, underscore; not starting with a digit); got ${JSON.stringify(name)}`,
			);
		}
		if (RESERVED_TAG_NAMES.has(name)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`registerTag({ tagName: '${name}' }) — '${name}' is a built-in inker directive and cannot be overridden`,
			);
		}
		if (typeof tag.compile !== "function") {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`registerTag({ tagName: '${name}' }) — compile must be a function`,
			);
		}
		this.#tags.set(name, tag);
		// A new tag name changes parse output; drop any AST parsed without it.
		this.clearCache();
	}

	/**
	 * Absolute path a template name resolves to (Edge `loader.makePath`), disk
	 * prefix and containment checks included. Does not touch the filesystem —
	 * use it to report WHERE a template was looked for.
	 */
	makePath(name: string): string {
		return this.#resolveTemplateFile(name).absPath;
	}

	/**
	 * A template's source (Edge `loader.resolve`). An in-memory template
	 * registered through `registerTemplate` wins over the disk, exactly as it
	 * does during a render.
	 *
	 * INKER DEVIATION (named): Edge hangs this on `edge.loader`; inker has no
	 * separate loader object, so the disk surface lives on the engine itself.
	 */
	resolve(name: string): { template: string } {
		const inMemory = this.#inMemory.get(
			validateName(this.#splitDisk(name).bare),
		);
		if (inMemory !== undefined) return { template: inMemory };
		const { absPath } = this.#resolveTemplateFile(name);
		try {
			return { template: fs.readFileSync(absPath, "utf8") };
		} catch {
			throw new InkerRenderError(
				"E_INKER_TEMPLATE_NOT_FOUND",
				`Template not found: ${absPath}`,
				{ templateName: name, templatePath: absPath },
			);
		}
	}

	/** The mounted disks, name → canonicalised root (Edge `loader.mounted`).
	 * `default` is the root the engine was constructed with. */
	get mounted(): Readonly<Record<string, string>> {
		const out: Record<string, string> = { default: this.#root };
		for (const [name, root] of this.#disks) out[name] = root;
		return Object.freeze(out);
	}

	/** Templates registered in memory (Edge `loader.templates`). */
	get templates(): Readonly<Record<string, { template: string }>> {
		const out: Record<string, { template: string }> = Object.create(null);
		for (const [name, template] of this.#inMemory) out[name] = { template };
		return Object.freeze(out);
	}

	/**
	 * Every component reachable as a tag, per mounted disk (Edge
	 * `loader.listComponents`). A `components/button.inker` becomes `@button`,
	 * `components/form/input.inker` becomes `@form.input`, and an `index`
	 * segment drops out so `components/form/index.inker` is `@form`. Names are
	 * camel-cased, and a non-default disk prefixes its own name.
	 */
	listComponents(): {
		diskName: string;
		components: { componentName: string; tagName: string }[];
	}[] {
		const disks: [string, string][] = [["default", this.#root]];
		for (const [name, root] of this.#disks) disks.push([name, root]);
		return disks.map(([diskName, root]) => ({
			diskName,
			components: this.#scanComponents(diskName, root),
		}));
	}

	#scanComponents(
		diskName: string,
		root: string,
	): { componentName: string; tagName: string }[] {
		const dir = path.join(root, "components");
		let files: string[];
		try {
			files = fs
				.readdirSync(dir, { recursive: true, encoding: "utf8" })
				.filter((f) => f.endsWith(TEMPLATE_EXT));
		} catch {
			// No components directory on this disk — not an error.
			return [];
		}
		const out: { componentName: string; tagName: string }[] = [];
		for (const file of files) {
			const rel = file.slice(0, -TEMPLATE_EXT.length).split(path.sep).join("/");
			const segments = rel.split("/");
			const tag = segments
				// A trailing `index` names its directory: `form/index` → `form`.
				.filter((seg, i) => i === 0 || seg !== "index")
				.map((seg) => camelCaseSegment(seg))
				.join(".");
			if (tag === "" || !COMPONENT_TAG_RE.test(tag)) continue;
			// INKER DEVIATION (named): Edge's `componentName` is the full
			// `components/<path>`; inker's `@component()` already resolves under
			// `components/`, so the name a caller can actually pass is the bare
			// relative path.
			const componentName = rel;
			out.push(
				diskName === "default"
					? { componentName, tagName: tag }
					: {
							componentName: `${diskName}::${componentName}`,
							tagName: `${diskName}.${tag}`,
						},
			);
		}
		return out;
	}

	/**
	 * Refresh the component-tag map. Called before every render (like Edge's
	 * bundled `supercharged` plugin), but the directory is only re-scanned when
	 * AST caching is off — with caching on, a new component file needs a
	 * `clearCache()` anyway.
	 */
	#refreshComponentTags(): void {
		if (this.#componentTags !== undefined && this.#cacheMode !== "mtime")
			return;
		const next = new Map<string, string>();
		for (const { components } of this.listComponents()) {
			for (const { componentName, tagName } of components) {
				next.set(tagName, componentName);
			}
		}
		const changed =
			this.#componentTags === undefined ||
			this.#componentTags.size !== next.size ||
			[...next].some(([k, v]) => this.#componentTags?.get(k) !== v);
		this.#componentTags = next;
		// The map changes how templates PARSE, so a stale AST must not survive it.
		if (changed && this.#componentTags !== undefined) this.clearCache();
	}

	/** The component-tag map as the JSON the Rust parser expects. */
	#componentTagsJson(): string {
		if (this.#componentTags === undefined || this.#componentTags.size === 0) {
			return "";
		}
		return JSON.stringify(Object.fromEntries(this.#componentTags));
	}

	/** Names of the registered tags declared `block: true` — the parser needs
	 * them separately, to know which `@end<name>` closers exist. */
	#blockTagNames(): string[] {
		const names: string[] = [];
		for (const [name, tag] of this.#tags) {
			if (tag.block === true) names.push(name);
		}
		return names;
	}

	/**
	 * Split an optionally-namespaced template name into its resolution root and
	 * bare (disk-relative) name. `name::path` → the mounted disk's root; a bare
	 * `path` → the default root. Unknown disk → loud E_INKER_INVALID_PATH.
	 */
	#splitDisk(name: string): { root: string; bare: string } {
		const sep = name.indexOf("::");
		if (sep === -1) return { root: this.#root, bare: name };
		const disk = name.slice(0, sep);
		const bare = name.slice(sep + 2);
		const root = this.#disks.get(disk);
		if (root === undefined) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Unknown templates disk '${disk}' in '${name}' — mount it with Templates#mount('${disk}', dir) first`,
				{ templateName: name },
			);
		}
		return { root, bare };
	}

	/**
	 * Resolve an (optionally `disk::`-prefixed) template name to its disk root,
	 * validated bare name, and absolute `.inker` path — with per-disk
	 * containment. `prefix` is prepended to the bare name AFTER the disk split
	 * (used for `components/` so `disk::button` → `<disk>/components/button`).
	 */
	#resolveTemplateFile(
		name: string,
		prefix = "",
	): { root: string; validated: string; absPath: string } {
		const { root, bare } = this.#splitDisk(name);
		const validated = validateName(`${prefix}${bare}`);
		const absPath = path.join(root, `${validated}${TEMPLATE_EXT}`);
		assertContained(root, absPath, validated);
		return { root, validated, absPath };
	}

	/**
	 * Render a template from disk.
	 *
	 * The whole body — resolution, composition, layout/section assembly — is a
	 * generator that ASKS for each load and each sub-render. `render` serves
	 * those requests with promise I/O, `renderSync` with the synchronous calls,
	 * and neither owns a second copy of the logic. That is what makes a
	 * `renderSync` safe to offer at all: the containment rules and the
	 * composition run from ONE place.
	 */
	async render(
		name: string,
		data: Readonly<Record<string, unknown>> = {},
	): Promise<string> {
		const step = this.#renderSteps(name, data);
		let next = step.next();
		while (!next.done) {
			const req = next.value;
			const html =
				"nodes" in req
					? await renderNodeTreeAsync(
							req.nodes,
							req.state,
							this.#renderHelpers(),
							req.ctx,
						)
					: await this.#loadAst(req.absPath, req.validatedName, req.root);
			next = step.next(html);
		}
		return next.value;
	}

	/**
	 * Render a template from disk, synchronously (AdonisJS `renderSync`).
	 *
	 * An expression using `await` raises here, exactly as it does upstream —
	 * `render` is the awaiting counterpart.
	 */
	renderSync(
		name: string,
		data: Readonly<Record<string, unknown>> = {},
	): string {
		const step = this.#renderSteps(name, data);
		let next = step.next();
		while (!next.done) {
			const req = next.value;
			const html =
				"nodes" in req
					? renderNodeTree(req.nodes, req.state, this.#renderHelpers(), req.ctx)
					: this.#loadAstSync(req.absPath, req.validatedName, req.root);
			next = step.next(html);
		}
		return next.value;
	}

	*#renderSteps(
		name: string,
		data: Readonly<Record<string, unknown>>,
	): RenderSteps {
		// Plugins run before anything is resolved — one may register a global or
		// a tag this very render depends on.
		this.#executePlugins();
		const { root, validated, absPath } = this.#resolveTemplateFile(name);

		// Registered globals sit UNDER the caller's data; validation then runs on
		// the merged tree, so a bad global is rejected here rather than surfacing
		// as a render-time fault in an unrelated template.
		const state = this.#withGlobals(data);

		// Validate the data tree (rejects NaN / ±Infinity / out-of-range bigint /
		// sparse holes / circular refs) — the Node renderer evaluates the ORIGINAL
		// data in V8 (Maps/Sets intact), so `encodeData`'s result is discarded and
		// only its guard side-effects are kept.
		encodeData(state);

		const entryAst = askedForAst(yield loadRequest(absPath, validated, root));
		const composed = yield* this.#compose(
			entryAst,
			validated,
			absPath,
			new Set([absPath]),
		);

		// Node renderer (62-2 pivot): convert the loaded AST handles to JSON node
		// lists and evaluate every expression in Node's own V8 with the helpers in
		// scope (Edge model — no tape, no QuickJS, no FFI).
		const partials = new Map<string, readonly InkerNodeJson[]>();
		for (const [key, handle] of composed.partialAsts) {
			partials.set(key, this.#astNodes(handle));
		}
		const components = new Map<string, readonly InkerNodeJson[]>();
		for (const [key, handle] of composed.componentAsts) {
			components.set(key, this.#astNodes(handle));
		}

		const childNodes = this.#astNodes(composed.bodyAst);
		// ONE stack store for the whole composition: `@pushTo` in the body (or in
		// a partial, or a component) must reach a `@stack` the layout renders
		// last. Placeholders are substituted once everything has rendered.
		const stacks = new Stacks();
		const baseCtx = {
			partials,
			components,
			tags: this.#tags,
			templateName: name,
			stacks,
		};

		// No layout → render the child directly (`@section`s render inline).
		if (composed.layoutAst === undefined) {
			return this.#applyOutput(
				stacks.fillPlaceholders(
					askedForHtml(yield { nodes: childNodes, state, ctx: baseCtx }),
				),
				name,
			);
		}

		// With a layout: separate the child's `@section` fills from the default
		// body, render each section (with `@super` = the layout's default for it),
		// and inject them at the layout's matching yields (62-3).
		const { sections: childSections, body: childBody } =
			collectSections(childNodes);
		const bodyHtml = askedForHtml(
			yield { nodes: childBody, state, ctx: baseCtx },
		);

		const layoutNodes = this.#astNodes(composed.layoutAst);
		const { sections: layoutDefaults } = collectSections(layoutNodes);
		const sections = new Map<string, string>();
		for (const [name, sectionNodes] of childSections) {
			const layoutDefault = layoutDefaults.get(name);
			const superHtml =
				layoutDefault !== undefined
					? askedForHtml(yield { nodes: layoutDefault, state, ctx: baseCtx })
					: "";
			sections.set(
				name,
				askedForHtml(
					yield {
						nodes: sectionNodes,
						state,
						ctx: { ...baseCtx, superHtml },
					},
				),
			);
		}

		return this.#applyOutput(
			stacks.fillPlaceholders(
				askedForHtml(
					yield {
						nodes: layoutNodes,
						state,
						ctx: { ...baseCtx, bodyHtml, sections },
					},
				),
			),
			name,
		);
	}

	/** Convert a parsed AST handle to its JSON node list (62-2 Node renderer). */
	#astNodes(handle: NapiInkerAst): readonly InkerNodeJson[] {
		const parsed: { nodes: readonly InkerNodeJson[] } = JSON.parse(
			getNative().astToJson(handle),
		);
		return parsed.nodes;
	}

	renderString(
		source: string,
		data: Readonly<Record<string, unknown>> = {},
	): string {
		this.#executePlugins();
		// T4 + P15: strip ALL U+FEFF (BOM) characters, not just a leading one.
		// `validateName` already refuses BOM in any position of a template
		// name; source built by concatenating multiple BOM-prefixed fragments
		// can leak interior BOMs into rendered HTML and confuse downstream
		// parsers. Keep symmetry with #loadAstUncached on the leading case
		// while extending coverage to internal occurrences.
		const normalisedSource = source.includes("﻿")
			? source.replace(/﻿/g, "")
			: source;
		const native = getNative();
		// `raw` processors also apply to inline sources — the stage is about the
		// source text, not about where it came from.
		const processedSource = this.#applyRaw(normalisedSource);
		const ast = callNative(() =>
			native.parseTemplate(
				processedSource,
				this.#parseNames(),
				[...this.#tags.keys()],
				this.#blockTagNames(),
				this.#componentTagsJson(),
			),
		);

		const info = ast.composeInfo;
		// The Rust parser separates a leading `@layout()` into `ast.layout`
		// (not a body node), so `firstDiskNode` won't surface it — check
		// `hasLayout` explicitly to preserve the renderString disk-required guard.
		if (info.hasLayout) {
			throw new InkerRenderError(
				"E_INKER_DISK_REQUIRED",
				`Templates#renderString cannot resolve @layout('${info.layoutName ?? ""}') — use Templates#render(name, data) instead`,
			);
		}
		const disk = info.firstDiskNode;
		if (disk !== null && disk !== undefined) {
			if (disk.kind === "Layout") {
				throw new InkerRenderError(
					"E_INKER_DISK_REQUIRED",
					`Templates#renderString cannot resolve @layout('${disk.name}') — use Templates#render(name, data) instead`,
				);
			}
			if (disk.kind === "Partial") {
				throw new InkerRenderError(
					"E_INKER_DISK_REQUIRED",
					`Templates#renderString cannot resolve @include('${disk.name}') — use Templates#render(name, data) instead`,
				);
			}
			if (disk.kind === "Component") {
				throw new InkerRenderError(
					"E_INKER_DISK_REQUIRED",
					`Templates#renderString cannot resolve @component('${disk.name}') — use Templates#render(name, data) instead`,
				);
			}
			throw new InkerRenderError(
				"E_INKER_DISK_REQUIRED",
				`Templates#renderString cannot use {{> ${disk.name} }} outside of a layout — the slot has no parent layout to inject into`,
			);
		}

		// No disk directives here (rejected above), so a bare node list renders
		// through the Node renderer (62-2 pivot) with the helpers in scope.
		// Globals apply to inline sources too, on the same precedence as render().
		const state = this.#withGlobals(data);
		// Validate the data tree (guard side-effects only; render the original).
		encodeData(state);
		const stacks = new Stacks();
		return this.#applyOutput(
			stacks.fillPlaceholders(
				renderNodeTree(this.#astNodes(ast), state, this.#renderHelpers(), {
					tags: this.#tags,
					stacks,
				}),
			),
		);
	}

	/**
	 * Share a value with every template rendered by this engine (Edge
	 * `edge.global`). Later registrations overwrite earlier ones, and per-render
	 * data always wins over a global of the same name.
	 */
	global(name: string, value: unknown): void {
		if (typeof name !== "string") {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Global name must be a string; got ${typeof name}`,
			);
		}
		if (!HELPER_NAME_RE.test(name)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Global name '${name}' is not a valid identifier (must match /^[a-zA-Z_$][a-zA-Z0-9_$]*$/)`,
				{ templateName: name },
			);
		}
		// Same denylist as object-literal keys and each-bindings: a global named
		// `__proto__` / `constructor` / `prototype` would be assigned onto the
		// merged state object and shadow Object.prototype for every template.
		if (PROTOTYPE_POLLUTION_KEYS.has(name)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Global name '${name}' is not allowed (prototype-pollution key)`,
				{ templateName: name },
			);
		}
		this.#globals.set(name, value);
		if (isHelperFn(value)) {
			this.#globalFns.set(name, value);
			this.#composedHelpers = undefined;
			// A callable global changes how templates PARSE — `{{ t('k') }}` only
			// compiles once the parser knows `t`. Same contract as registerTag:
			// register during boot, before the first render.
			this.clearCache();
		} else if (this.#globalFns.delete(name)) {
			// Overwriting a callable global with a plain value withdraws the helper.
			this.#composedHelpers = undefined;
			this.clearCache();
		}
	}

	/** Helper names known to the parser: constructor helpers + callable globals. */
	#parseNames(): string[] {
		return this.#globalFns.size === 0
			? [...this.#helperNames]
			: [...this.#helperNames, ...this.#globalFns.keys()];
	}

	/** Render-time helper map: constructor helpers overlaid with callable globals. */
	#renderHelpers(): ReadonlyMap<string, HelperFn> {
		if (this.#globalFns.size === 0) return this.#helpers;
		if (this.#composedHelpers === undefined) {
			const merged = new Map(this.#helpers);
			for (const [name, fn] of this.#globalFns) merged.set(name, fn);
			this.#composedHelpers = merged;
		}
		return this.#composedHelpers;
	}

	/**
	 * Run a plugin against this engine (Edge `edge.use`). The plugin receives the
	 * engine and registers whatever it needs — globals, tags. Returns the engine
	 * so calls chain.
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
		// Registration only. Edge defers plugins to the first render so one
		// registered before `mount()` or `configure()` still observes the engine
		// as it ends up, not as it was mid-boot.
		this.#plugins.push({
			run: (firstRun) => plugin(this, firstRun, options),
			options,
			executed: false,
		});
		return this;
	}

	/**
	 * Run the plugins that are due: each one once, plus every `recurring` plugin
	 * again. `firstRun` lets a plugin split one-time registration from the
	 * per-render work.
	 */
	#executePlugins(): void {
		for (const plugin of this.#plugins) {
			if (plugin.executed && plugin.options?.recurring !== true) continue;
			const firstRun = !plugin.executed;
			// Set BEFORE calling: a plugin that renders would otherwise re-enter
			// here, see itself as pending, and recurse.
			plugin.executed = true;
			plugin.run(firstRun);
		}
		// Bundled last, exactly like Edge runs its own plugins after user-land
		// ones — a plugin may have mounted the disk we are about to scan.
		this.#refreshComponentTags();
	}

	/** The registered globals, as a read-only view (Edge `edge.globals`). */
	get globals(): ReadonlyMap<string, unknown> {
		return this.#globals;
	}

	/** The registered custom tags, as a read-only view (Edge `edge.tags`). */
	get tags(): ReadonlyMap<string, InkerTag> {
		return this.#tags;
	}

	createRenderer(): TemplateRenderer {
		this.#executePlugins();
		const renderer = new TemplateRenderer(this);
		for (const callback of this.#renderCallbacks) callback(renderer);
		return renderer;
	}

	/**
	 * Run `callback` against every renderer this engine creates (Edge
	 * `onRender`). This is how a plugin seeds per-render state it cannot know at
	 * registration time — the request, the signed-in user — without reaching
	 * into the call site of every `createRenderer()`.
	 */
	onRender(callback: (renderer: TemplateRenderer) => void): this {
		if (typeof callback !== "function") {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`onRender() expects a function; got ${typeof callback}`,
			);
		}
		this.#renderCallbacks.push(callback);
		return this;
	}

	/**
	 * Shorthand for `createRenderer().share(data)` (Edge `share`). The engine
	 * itself holds no per-render state, so this hands back a renderer rather
	 * than mutating the engine — sharing on the engine would leak one request's
	 * data into the next.
	 */
	share(data: Readonly<Record<string, unknown>>): TemplateRenderer {
		return this.createRenderer().share(data);
	}

	/**
	 * Re-apply engine options after construction (Edge `configure`). Only the
	 * options that can meaningfully change on a live engine are accepted: the
	 * root is a containment boundary fixed at construction, and moving it would
	 * invalidate every mounted disk's guarantees.
	 *
	 * Changing the cache mode drops the AST cache, since entries carry the
	 * validation strategy they were stored under.
	 */
	configure(options: Readonly<{ cacheMode?: CacheMode }>): void {
		if (options.cacheMode === undefined) return;
		this.#cacheMode = resolveCacheMode(options.cacheMode);
		this.clearCache();
	}

	/**
	 * Merge the registered globals UNDER the caller's data — per-render state
	 * wins on a name collision, matching Edge's precedence. Returns `data`
	 * untouched when nothing is registered, so the common path allocates nothing.
	 */
	#withGlobals(
		data: Readonly<Record<string, unknown>>,
	): Readonly<Record<string, unknown>> {
		if (this.#globals.size === 0) return data;
		const merged: Record<string, unknown> = Object.create(null);
		for (const [name, value] of this.#globals) merged[name] = value;
		if (typeof data === "object" && data !== null && !Array.isArray(data)) {
			Object.assign(merged, data);
		}
		return merged;
	}

	/** Run the registered `raw` transforms over a template source. */
	#applyRaw(raw: string, path?: string): string {
		return this.processor.applyRaw(raw, path);
	}

	/** Run the registered `output` transforms over rendered HTML. */
	#applyOutput(output: string, template?: string): string {
		return this.processor.applyOutput(output, template);
	}

	/**
	 * Parse a template from disk WITHOUT rendering it (Edge `compile`) — the
	 * syntax check a linter or an editor integration wants.
	 *
	 * Throws {@link InkerRenderError} carrying `code`, `line` and `column` when
	 * the template does not parse; returns nothing when it does.
	 *
	 * Named deviation, NAPI: Edge compiles to a JavaScript function and hands
	 * it back. Inker's compiler is in Rust and produces an opaque native AST
	 * handle, which has no meaning on this side of the bridge — so the method
	 * reports whether the template parses instead of returning the artifact.
	 */
	compile(name: string): void {
		const { root, validated, absPath } = this.#resolveTemplateFile(name);
		this.#loadAstSync(absPath, validated, root);
	}

	/**
	 * Parse a template STRING without rendering it (Edge `compileRaw`). See
	 * {@link compile} for what it throws and why it returns nothing.
	 *
	 * `templateName` only labels the error, as it does upstream.
	 */
	compileRaw(source: string, templateName?: string): void {
		// The same normalisation `renderString` applies before parsing: a BOM
		// would otherwise be reported as a syntax error the file does not have.
		const normalised = source.includes("\ufeff")
			? source.replace(/\ufeff/g, "")
			: source;
		try {
			callNative(() =>
				getNative().parseTemplate(
					this.#applyRaw(normalised),
					this.#parseNames(),
					[...this.#tags.keys()],
					this.#blockTagNames(),
					this.#componentTagsJson(),
				),
			);
		} catch (err) {
			// A string has no path of its own, so the caller's label is the only
			// thing that tells a reader WHICH template failed.
			if (templateName === undefined || !(err instanceof InkerRenderError))
				throw err;
			throw new InkerRenderError(
				err.code,
				err.message,
				{ ...err.context, templateName },
				{ cause: err },
			);
		}
	}

	/**
	 * Render a template string (Edge `renderRawSync`). `renderString` is the
	 * historical inker name and stays; this is the Edge-shaped alias.
	 */
	renderRawSync(
		source: string,
		data: Readonly<Record<string, unknown>> = {},
	): string {
		return this.renderString(source, data);
	}

	/**
	 * Render a template string, asynchronously (Edge `renderRaw`). Inker parses
	 * and renders synchronously, so this resolves immediately — it exists so code
	 * written against Edge's async signature ports without a rewrite.
	 */
	async renderRaw(
		source: string,
		data: Readonly<Record<string, unknown>> = {},
	): Promise<string> {
		return this.renderString(source, data);
	}

	/**
	 * Register a template from memory (Edge `registerTemplate`). It resolves
	 * under the name given — including a `components/…` or layout name — and
	 * takes precedence over a file of the same name.
	 */
	registerTemplate(name: string, contents: { template: string }): void {
		if (typeof name !== "string" || name.length === 0) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`registerTemplate — name must be a non-empty string; got ${typeof name}`,
			);
		}
		if (typeof contents?.template !== "string") {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`registerTemplate('${name}') — contents.template must be a string`,
			);
		}
		// Validate the name on the same rules as a disk lookup: an in-memory
		// template must not be reachable under a name a file could never carry,
		// or the two namespaces drift apart.
		this.#inMemory.set(validateName(name), contents.template);
		this.clearCache();
	}

	/** Drop a template registered from memory (Edge `removeTemplate`). */
	removeTemplate(name: string): void {
		if (this.#inMemory.delete(validateName(name))) this.clearCache();
	}

	clearCache(): void {
		this.#cacheGeneration += 1;
		this.#cache.clear();
		// T7: also drop the in-flight promise dedup map so the next render()
		// for any in-flight key forces a fresh load instead of reusing the
		// pre-clear promise. The promise itself still resolves for whoever
		// awaited it (and may write its stale AST to the cache); the
		// #cacheGeneration counter discards that write — see #loadAstUncached.
		this.#inflight.clear();
	}

	async #loadAst(
		absPath: string,
		validatedName: string,
		root: string,
	): Promise<NapiInkerAst> {
		// Key the cache/inflight maps by the resolving disk's root AND the
		// absolute path, not the path alone. Two disks with overlapping roots
		// can resolve the SAME absPath; keying by path alone would let disk A's
		// entry (which passed containment against A's root) be served to disk B
		// on a cache hit — bypassing B's symlink-containment check, which only
		// runs on a cache MISS. The compound key isolates each disk's cache.
		// An in-memory template short-circuits the whole disk path: no stat, no
		// open, no mtime cache. It is parsed on each load — there is no file to
		// watch for staleness, and registerTemplate() already clears the cache.
		const inMemory = this.#inMemory.get(validatedName);
		if (inMemory !== undefined) {
			const source = this.#applyRaw(inMemory);
			return callNative(() =>
				getNative().parseTemplate(
					source,
					this.#parseNames(),
					[...this.#tags.keys()],
					this.#blockTagNames(),
					this.#componentTagsJson(),
				),
			);
		}

		const cacheKey = `${root}\u0000${absPath}`;
		const inflight = this.#inflight.get(cacheKey);
		if (inflight !== undefined) return inflight;

		const promise = this.#loadAstUncached(absPath, validatedName, root);
		this.#inflight.set(cacheKey, promise);
		try {
			return await promise;
		} finally {
			this.#inflight.delete(cacheKey);
		}
	}

	async #loadAstUncached(
		absPath: string,
		validatedName: string,
		root: string,
	): Promise<NapiInkerAst> {
		// T7: snapshot the cache generation. If clearCache() runs while this
		// load is in flight, the snapshot will diverge from #cacheGeneration
		// at write-back time, and we'll skip the cache.set() to avoid
		// silently restoring a stale AST after operator invalidation.
		const loadGeneration = this.#cacheGeneration;
		// Same compound (root, absPath) key as #loadAst — see the note there.
		const cacheKey = `${root}\u0000${absPath}`;
		const cached = this.#cache.get(cacheKey);

		if (this.#cacheMode === "never" && cached !== undefined) {
			return cached.ast;
		}

		let currentMtime = 0;
		if (this.#cacheMode === "mtime") {
			try {
				currentMtime = (await fsPromises.stat(absPath)).mtimeMs;
			} catch (cause) {
				throw wrapFsError(cause, absPath, validatedName);
			}
			// D1: treat mtime === 0 as "no timestamp available" rather than a
			// real value. Some FUSE filesystems, tar restores, and certain
			// network mounts surface mtimeMs: 0 as a sentinel. If we treated
			// that as a cacheable timestamp, the FIRST load would cache, and
			// every subsequent disk edit would also report mtimeMs: 0 → cache
			// hit → permanent silent staleness. Force a re-parse instead.
			// Cerebrum DNR #61 forbids size/hash checks; this preserves the
			// mtime-only spirit while handling the sentinel safely.
			if (
				currentMtime !== 0 &&
				cached !== undefined &&
				cached.mtimeMs === currentMtime
			) {
				return cached.ast;
			}
		}

		// T6 + P1: open the file with `O_NOFOLLOW` first, then validate the
		// canonical path against root, then read from the file handle. Previous
		// approach did two separate awaits on `absPath` (`realpath` then
		// `readFile`) — an attacker who swaps `absPath` for a symlink between
		// the two awaits would bypass the containment check and have the
		// content read follow the swapped link. Holding a FD pins the inode:
		// after `open` succeeds, subsequent path swaps cannot redirect the
		// read. `O_NOFOLLOW` additionally rejects the final segment being a
		// symlink at open time. The `realpath` check after open still races on
		// intermediate directory swaps but is now belt-and-suspenders rather
		// than the only line of defence.
		let handle: fsPromises.FileHandle;
		try {
			handle = await fsPromises.open(
				absPath,
				fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
			);
		} catch (cause) {
			throw wrapFsError(cause, absPath, validatedName);
		}
		let source: string;
		try {
			assertRealpathContained(absPath, root, validatedName);
			try {
				source = await handle.readFile("utf8");
			} catch (cause) {
				throw wrapFsError(cause, absPath, validatedName);
			}
		} finally {
			await handle.close();
		}

		return this.#parseAndCache(
			source,
			absPath,
			cacheKey,
			currentMtime,
			loadGeneration,
		);
	}

	/**
	 * Everything after the bytes are in hand: strip the BOM, run the `raw`
	 * processors, parse, and cache. Shared by both loaders — only the four I/O
	 * calls differ between them, and none of this should.
	 */
	#parseAndCache(
		rawSource: string,
		absPath: string,
		cacheKey: string,
		currentMtime: number,
		loadGeneration: number,
	): NapiInkerAst {
		// T4: strip leading UTF-8 BOM if present. Windows editors (Notepad)
		// commonly insert it; lex sees it as a Text token, defeating the
		// "first non-stripped node must be Layout" composition rule and
		// silently treating `@layout()` as body content.
		let source =
			rawSource.charCodeAt(0) === 0xfeff ? rawSource.slice(1) : rawSource;
		// `raw` processors see the file's source before it is parsed.
		source = this.#applyRaw(source, absPath);

		const ast = callNative(() =>
			getNative().parseTemplate(
				source,
				this.#parseNames(),
				[...this.#tags.keys()],
				this.#blockTagNames(),
				this.#componentTagsJson(),
			),
		);

		// T7: only populate the cache if the generation is unchanged. If
		// clearCache() was called during the await chain above, the new
		// generation discards this write — the next render() starts fresh.
		if (this.#cacheGeneration === loadGeneration) {
			this.#cache.set(cacheKey, { ast, mtimeMs: currentMtime });
		}
		return ast;
	}

	/**
	 * The synchronous twin of `#loadAstUncached`.
	 *
	 * Only the four I/O calls differ — `statSync`/`openSync`/`readFileSync`/
	 * `closeSync` against their promise forms. The containment rule
	 * (`assertRealpathContained`) and everything after the read
	 * (`#parseAndCache`) are the SAME functions, so the two paths cannot drift
	 * on the parts that matter.
	 */
	#loadAstUncachedSync(
		absPath: string,
		validatedName: string,
		root: string,
	): NapiInkerAst {
		const loadGeneration = this.#cacheGeneration;
		const cacheKey = `${root}\u0000${absPath}`;
		const cached = this.#cache.get(cacheKey);

		if (this.#cacheMode === "never" && cached !== undefined) {
			return cached.ast;
		}

		let currentMtime = 0;
		if (this.#cacheMode === "mtime") {
			try {
				currentMtime = fs.statSync(absPath).mtimeMs;
			} catch (cause) {
				throw wrapFsError(cause, absPath, validatedName);
			}
			// D1: mtimeMs 0 is a "no timestamp" sentinel on some filesystems —
			// caching on it would freeze the template forever. See the async twin.
			if (
				currentMtime !== 0 &&
				cached !== undefined &&
				cached.mtimeMs === currentMtime
			) {
				return cached.ast;
			}
		}

		// T6 + P1: open with `O_NOFOLLOW` first so a later path swap cannot
		// redirect the read, then validate what the OS resolved.
		let fd: number;
		try {
			fd = fs.openSync(
				absPath,
				fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
			);
		} catch (cause) {
			throw wrapFsError(cause, absPath, validatedName);
		}
		let source: string;
		try {
			assertRealpathContained(absPath, root, validatedName);
			try {
				source = fs.readFileSync(fd, "utf8");
			} catch (cause) {
				throw wrapFsError(cause, absPath, validatedName);
			}
		} finally {
			fs.closeSync(fd);
		}

		return this.#parseAndCache(
			source,
			absPath,
			cacheKey,
			currentMtime,
			loadGeneration,
		);
	}

	/**
	 * Synchronous `#loadAst`: the in-memory short-circuit, then the loader.
	 * No in-flight map — a synchronous load cannot overlap another.
	 */
	#loadAstSync(
		absPath: string,
		validatedName: string,
		root: string,
	): NapiInkerAst {
		const inMemory = this.#inMemory.get(validatedName);
		if (inMemory !== undefined) {
			const source = this.#applyRaw(inMemory);
			return callNative(() =>
				getNative().parseTemplate(
					source,
					this.#parseNames(),
					[...this.#tags.keys()],
					this.#blockTagNames(),
					this.#componentTagsJson(),
				),
			);
		}
		return this.#loadAstUncachedSync(absPath, validatedName, root);
	}

	*#compose(
		entryAst: NapiInkerAst,
		entryName: string,
		entryAbsPath: string,
		includeStack: Set<string>,
	): ComposeStep<ComposedTemplate> {
		const partialAsts = new Map<string, NapiInkerAst>();
		const componentAsts = new Map<string, NapiInkerAst>();

		// The Rust parser already separates the leading `@layout()` into
		// `ast.layout` and excludes it from `ast.nodes`, so `entryAst` IS the
		// body AST (no slice). Duplicate / mis-placed layout directives are
		// rejected at parse time (parseTemplate throws E_INKER_DUPLICATE_LAYOUT /
		// E_INKER_INVALID_LAYOUT_POSITION), so no body-side dup-layout check is
		// needed here.
		const entryInfo = entryAst.composeInfo;
		const hasLayout = entryInfo.hasLayout;
		const bodyAst = entryAst;

		// Body ASTs must not contain Slot nodes: slots only mean something in a
		// layout-yield context.
		const bodySlot = entryInfo.slots[0];
		if (bodySlot !== undefined) {
			throw new InkerRenderError(
				"E_INKER_UNKNOWN_SLOT",
				`{{> ${bodySlot.name} }} outside of a layout — slot placeholders are only valid inside layout files (got at line ${bodySlot.line}, column ${bodySlot.column} in '${entryName}')`,
				{
					templatePath: entryAbsPath,
					templateName: entryName,
					line: bodySlot.line,
					column: bodySlot.column,
				},
			);
		}

		// Resolve partials + components reachable from the body AST. Both
		// resolvers recurse mutually, so the full transitive closure (partials
		// inside components and vice versa) is pre-loaded here.
		yield* this.#resolvePartialsIn(
			entryInfo.partials,
			partialAsts,
			componentAsts,
			includeStack,
			entryAbsPath,
		);
		yield* this.#resolveComponentsIn(
			entryInfo.components,
			partialAsts,
			componentAsts,
			includeStack,
			entryAbsPath,
		);

		if (!hasLayout) {
			return { bodyAst, partialAsts, componentAsts };
		}

		// Resolve the layout file.
		const layoutName = entryInfo.layoutName;
		if (layoutName === null) {
			// hasLayout true but no name — should be impossible (parse invariant).
			throw new InkerRenderError(
				"E_INKER_INVALID_LAYOUT_POSITION",
				`Internal: layout flagged but no layout name on '${entryName}'`,
				{ templatePath: entryAbsPath, templateName: entryName },
			);
		}
		const layoutLine = entryInfo.layoutLine ?? undefined;
		const layoutColumn = entryInfo.layoutColumn ?? undefined;
		const {
			root: layoutRoot,
			validated: layoutValidated,
			absPath: layoutAbsPath,
		} = this.#resolveTemplateFile(layoutName);

		if (includeStack.has(layoutAbsPath)) {
			throw new InkerRenderError(
				"E_INKER_CIRCULAR_INCLUDE",
				`Circular include: ${this.#cycleString(includeStack, layoutAbsPath)} (started at ${entryAbsPath})`,
				{
					templatePath: layoutAbsPath,
					templateName: layoutValidated,
					line: layoutLine,
					column: layoutColumn,
				},
			);
		}

		includeStack.add(layoutAbsPath);
		let layoutAst: NapiInkerAst;
		try {
			layoutAst = askedForAst(
				yield loadRequest(layoutAbsPath, layoutValidated, layoutRoot),
			);
		} catch (e) {
			includeStack.delete(layoutAbsPath);
			throw e;
		}

		try {
			const layoutInfo = layoutAst.composeInfo;

			// Nested-layout rejection.
			if (layoutInfo.hasLayout) {
				throw new InkerRenderError(
					"E_INKER_NESTED_LAYOUT_UNSUPPORTED",
					`Layout file '${layoutValidated}' itself contains @layout() — nested layouts are not supported`,
					{
						templatePath: layoutAbsPath,
						templateName: layoutValidated,
						line: layoutInfo.layoutLine ?? undefined,
						column: layoutInfo.layoutColumn ?? undefined,
					},
				);
			}

			// Unknown-slot rejection (any slot whose name is not "body").
			const unknownSlot = layoutInfo.slots.find((s) => s.name !== "body");
			if (unknownSlot !== undefined) {
				throw new InkerRenderError(
					"E_INKER_UNKNOWN_SLOT",
					`Unknown slot '${unknownSlot.name}' — Inker 53.2 only supports {{> body }}. Named sections arrive in 53.3.`,
					{
						templatePath: layoutAbsPath,
						templateName: layoutValidated,
						line: unknownSlot.line,
						column: unknownSlot.column,
					},
				);
			}

			// Missing-slot rejection (D11) — only when the body has real content.
			const hasBodySlot = layoutInfo.slots.some((s) => s.name === "body");
			if (!hasBodySlot && entryInfo.hasContent) {
				throw new InkerRenderError(
					"E_INKER_MISSING_SLOT",
					`Layout '${layoutValidated}' has no {{> body }} placeholder, cannot render body of child '${entryName}'`,
					{
						templatePath: layoutAbsPath,
						templateName: layoutValidated,
					},
				);
			}

			// Resolve partials + components reachable from the layout AST (mutual
			// recursion covers the full transitive closure).
			yield* this.#resolvePartialsIn(
				layoutInfo.partials,
				partialAsts,
				componentAsts,
				includeStack,
				layoutAbsPath,
			);
			yield* this.#resolveComponentsIn(
				layoutInfo.components,
				partialAsts,
				componentAsts,
				includeStack,
				layoutAbsPath,
			);
		} finally {
			includeStack.delete(layoutAbsPath);
		}

		return {
			bodyAst,
			layoutAst,
			layoutName: layoutValidated,
			layoutAbsPath,
			partialAsts,
			componentAsts,
		};
	}

	*#resolvePartialsIn(
		refs: readonly NapiNodeRef[],
		partialAsts: Map<string, NapiInkerAst>,
		componentAsts: Map<string, NapiInkerAst>,
		includeStack: Set<string>,
		hostAbsPath: string,
	): ComposeStep<void> {
		for (const node of refs) {
			const {
				root: partialRoot,
				validated: partialValidated,
				absPath: partialAbsPath,
			} = this.#resolveTemplateFile(node.name);
			const partialKey = normalizePartialKey(node.name);

			if (includeStack.has(partialAbsPath)) {
				throw new InkerRenderError(
					"E_INKER_CIRCULAR_INCLUDE",
					`Circular include: ${this.#cycleString(includeStack, partialAbsPath)} (referenced from ${hostAbsPath})`,
					{
						templatePath: partialAbsPath,
						templateName: partialValidated,
						line: node.line,
						column: node.column,
					},
				);
			}

			if (partialAsts.has(partialKey)) {
				// Already resolved (different host re-referenced the same partial).
				continue;
			}

			includeStack.add(partialAbsPath);
			let partialAst: NapiInkerAst;
			try {
				partialAst = askedForAst(
					yield loadRequest(partialAbsPath, partialValidated, partialRoot),
				);
			} catch (e) {
				includeStack.delete(partialAbsPath);
				throw e;
			}

			try {
				const info = partialAst.composeInfo;
				// Layout-in-partial rejection.
				if (info.hasLayout) {
					throw new InkerRenderError(
						"E_INKER_LAYOUT_IN_PARTIAL",
						`Partial file '${partialValidated}' contains @layout() — partials cannot declare layouts`,
						{
							templatePath: partialAbsPath,
							templateName: partialValidated,
							line: info.layoutLine ?? undefined,
							column: info.layoutColumn ?? undefined,
						},
					);
				}

				// Slot-in-partial rejection: slots only mean something in layouts.
				const slot = info.slots[0];
				if (slot !== undefined) {
					throw new InkerRenderError(
						"E_INKER_UNKNOWN_SLOT",
						`Partial '${partialValidated}' contains {{> ${slot.name} }} — slot placeholders are only valid inside layout files (line ${slot.line}, column ${slot.column})`,
						{
							templateName: partialValidated,
							line: slot.line,
							column: slot.column,
						},
					);
				}

				partialAsts.set(partialKey, partialAst);

				// Recurse into nested partials AND components reachable from this
				// partial (mutual recursion → full transitive closure).
				yield* this.#resolvePartialsIn(
					info.partials,
					partialAsts,
					componentAsts,
					includeStack,
					partialAbsPath,
				);
				yield* this.#resolveComponentsIn(
					info.components,
					partialAsts,
					componentAsts,
					includeStack,
					partialAbsPath,
				);
			} finally {
				includeStack.delete(partialAbsPath);
			}
		}
	}

	*#resolveComponentsIn(
		refs: readonly NapiNodeRef[],
		partialAsts: Map<string, NapiInkerAst>,
		componentAsts: Map<string, NapiInkerAst>,
		includeStack: Set<string>,
		hostAbsPath: string,
	): ComposeStep<void> {
		for (const node of refs) {
			// Split the optional `disk::` prefix off FIRST, then prepend the
			// `components/` directory to the bare name so `disk::button` resolves
			// to `<disk>/components/button.inker`, not `<default>/components/disk::button`.
			const {
				root: componentRoot,
				validated: componentValidated,
				absPath: componentAbsPath,
			} = this.#resolveTemplateFile(node.name, "components/");
			const componentKey = normalizePartialKey(node.name);

			if (includeStack.has(componentAbsPath)) {
				throw new InkerRenderError(
					"E_INKER_CIRCULAR_INCLUDE",
					`Circular include: ${this.#cycleString(includeStack, componentAbsPath)} (referenced from ${hostAbsPath})`,
					{
						templatePath: componentAbsPath,
						templateName: componentValidated,
						line: node.line,
						column: node.column,
					},
				);
			}

			if (componentAsts.has(componentKey)) {
				continue;
			}

			includeStack.add(componentAbsPath);
			let componentAst: NapiInkerAst;
			try {
				componentAst = askedForAst(
					yield loadRequest(
						componentAbsPath,
						componentValidated,
						componentRoot,
					),
				);
			} catch (e) {
				includeStack.delete(componentAbsPath);
				throw e;
			}

			try {
				const info = componentAst.composeInfo;
				// Layout-in-component rejection (reuse E_INKER_LAYOUT_IN_PARTIAL
				// per AC5: same axis "layout in non-entry file").
				if (info.hasLayout) {
					throw new InkerRenderError(
						"E_INKER_LAYOUT_IN_PARTIAL",
						`Component file '${componentValidated}' contains @layout() — components cannot declare layouts`,
						{
							templatePath: componentAbsPath,
							templateName: componentValidated,
							line: info.layoutLine ?? undefined,
							column: info.layoutColumn ?? undefined,
						},
					);
				}

				// A component template MAY contain slot placeholders: `{{> body }}`
				// yields the default (block-body) slot and `{{> name }}` a named
				// `@slot('name')` provided by the caller. Placeholders with no
				// matching slot render empty (Edge parity), so no validation here.

				componentAsts.set(componentKey, componentAst);

				// Recurse into nested components AND partials included inside this
				// component (mutual recursion → a @include() in a component is
				// pre-loaded, fixing E_INKER_DISK_REQUIRED at render time).
				yield* this.#resolveComponentsIn(
					info.components,
					partialAsts,
					componentAsts,
					includeStack,
					componentAbsPath,
				);
				yield* this.#resolvePartialsIn(
					info.partials,
					partialAsts,
					componentAsts,
					includeStack,
					componentAbsPath,
				);
			} finally {
				includeStack.delete(componentAbsPath);
			}
		}
	}

	#cycleString(includeStack: Set<string>, revisited: string): string {
		const stackList = Array.from(includeStack);
		const revisitedIdx = stackList.indexOf(revisited);
		const cycleFrames =
			revisitedIdx >= 0 ? stackList.slice(revisitedIdx) : stackList;
		const rel = cycleFrames.map((p) => path.relative(this.#root, p));
		const relRevisited = path.relative(this.#root, revisited);
		return `${rel.join(" → ")} → ${relRevisited}`;
	}
}

export default Templates;

/**
 * A renderer with its own shared state (Edge `edge.createRenderer`).
 *
 * Created per request so `share()` state — the current URL, the signed-in user,
 * flash messages — reaches partials and components without touching the
 * process-wide engine. Two renderers never see each other's state.
 *
 * Precedence, lowest to highest: engine globals, this renderer's shared state,
 * then the data passed to the render call. The merge happens here, so the
 * engine needs no notion of who is rendering.
 */
export class TemplateRenderer {
	readonly #templates: Templates;
	readonly #shared: Record<string, unknown> = Object.create(null);

	constructor(templates: Templates) {
		this.#templates = templates;
	}

	/** Merge `data` into this renderer's shared state (Edge `share`). Chainable. */
	share(data: Readonly<Record<string, unknown>>): this {
		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`share() expects an object; got ${data === null ? "null" : typeof data}`,
			);
		}
		// Object.assign copies own enumerable keys only, onto a null-prototype
		// bag — a `__proto__` key lands as an own property instead of walking up
		// the prototype chain.
		Object.assign(this.#shared, data);
		return this;
	}

	render(
		name: string,
		data: Readonly<Record<string, unknown>> = {},
	): Promise<string> {
		return this.#templates.render(name, { ...this.#shared, ...data });
	}

	renderString(
		source: string,
		data: Readonly<Record<string, unknown>> = {},
	): string {
		return this.#templates.renderString(source, { ...this.#shared, ...data });
	}

	/** Render a template from disk, synchronously (AdonisJS `renderSync`). */
	renderSync(
		name: string,
		data: Readonly<Record<string, unknown>> = {},
	): string {
		return this.#templates.renderSync(name, { ...this.#shared, ...data });
	}

	/** Render a template string (Edge `renderRawSync`). Alias of `renderString`. */
	renderRawSync(
		source: string,
		data: Readonly<Record<string, unknown>> = {},
	): string {
		return this.renderString(source, data);
	}

	/** Render a template string, asynchronously (Edge `renderRaw`). */
	async renderRaw(
		source: string,
		data: Readonly<Record<string, unknown>> = {},
	): Promise<string> {
		return this.renderString(source, data);
	}

	/**
	 * A second renderer carrying a COPY of this one's shared state (Edge
	 * `clone`). Used to branch — a nested render that needs one extra value
	 * without that value leaking back into the renderer it came from.
	 */
	clone(): TemplateRenderer {
		return new TemplateRenderer(this.#templates).share(this.#shared);
	}

	/**
	 * The state this renderer would render with: engine globals underneath, its
	 * own shared values on top (Edge `getState`). Exists for assertions about
	 * what a plugin or an `onRender` callback actually shared.
	 */
	getState(): Record<string, unknown> {
		const state: Record<string, unknown> = Object.create(null);
		for (const [name, value] of this.#templates.globals) state[name] = value;
		Object.assign(state, this.#shared);
		return state;
	}
}
