import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { HelperFn } from "./helpers.js";
import { InkerRenderError } from "./InkerRenderError.js";
import {
	PROTOTYPE_POLLUTION_KEYS,
	RESERVED_BINDING_NAMES,
} from "./identifierGuards.js";
import {
	getNative,
	type NapiHelperResult,
	type NapiInkerAst,
	type NapiInvocation,
	type NapiNodeRef,
	type NapiRenderContext,
	napiThrowToInker,
} from "./loadNapi.js";
import { SafeString } from "./SafeString.js";

export type CacheMode = "auto" | "mtime" | "never";

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

const VALID_CACHE_MODES: ReadonlySet<string> = new Set([
	"auto",
	"mtime",
	"never",
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
	const helperNames = new Set<string>();
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

export class Templates {
	readonly #root: string;
	readonly #cacheMode: "mtime" | "never";
	readonly #cache: Map<string, CacheEntry> = new Map();
	readonly #inflight: Map<string, Promise<NapiInkerAst>> = new Map();
	// T7: monotonic counter bumped by clearCache(). #loadAstUncached snapshots
	// it before doing async I/O and refuses to write back to the cache if the
	// generation moved during the load — prevents a pre-clear in-flight load
	// from silently re-populating the cache after clearCache() ran.
	#cacheGeneration = 0;
	readonly #helpers: ReadonlyMap<string, HelperFn>;
	readonly #helperNames: ReadonlySet<string>;
	// Named template "disks" (AdonisJS/Edge `edge.mount(name, dir)` parity).
	// The DEFAULT disk is `#root` (the constructor `root`), addressed by a bare
	// `template` name; a NAMED disk is addressed as `name::template`. Each value
	// is a canonicalised absolute root — containment (assertContained + the
	// #loadAst symlink guard) is enforced against the disk's OWN root, never a
	// shared one, so mounting a package's templates cannot widen traversal.
	readonly #disks: Map<string, string> = new Map();

	constructor(options: TemplatesOptions) {
		this.#root = canonicalizeTemplatesRoot(options.root);

		const requested = options.cacheMode ?? "auto";
		if (!VALID_CACHE_MODES.has(requested)) {
			throw new InkerRenderError(
				"E_INKER_INVALID_PATH",
				`Templates cacheMode must be one of 'auto' | 'mtime' | 'never'; got ${JSON.stringify(requested)}`,
			);
		}
		if (requested === "auto") {
			this.#cacheMode =
				process.env.NODE_ENV === "production" ? "never" : "mtime";
		} else {
			this.#cacheMode = requested;
		}

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
	 * root, exactly like Edge. Re-mounting a name overwrites its root. `dir` is
	 * canonicalised (absolute + realpath) the same way the constructor root is,
	 * so each disk carries its own containment boundary.
	 */
	mount(diskName: string, dir: string): void {
		assertDiskName(diskName);
		this.#disks.set(diskName, canonicalizeTemplatesRoot(dir));
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
		const absPath = path.join(root, `${validated}.inker`);
		assertContained(root, absPath, validated);
		return { root, validated, absPath };
	}

	async render(
		name: string,
		data: Readonly<Record<string, unknown>>,
	): Promise<string> {
		const { root, validated, absPath } = this.#resolveTemplateFile(name);

		const entryAst = await this.#loadAst(absPath, validated, root);
		const composed = await this.#compose(
			entryAst,
			validated,
			absPath,
			new Set([absPath]),
		);

		const native = getNative();
		const encoded = encodeData(data);
		const partials = Object.fromEntries(composed.partialAsts);
		const components = Object.fromEntries(composed.componentAsts);

		// Body pass — collect helper invocations in render order, invoke them
		// TS-side, then render consuming the resolved tape (ADR-007 as adapted
		// for 55.1: collect→invoke→render, no V8 callback).
		const bodyCtx: NapiRenderContext = {
			partials,
			components,
			bodyHtml: undefined,
			templateName: validated,
			templatePath: absPath,
		};
		const bodyTape = callNative(() =>
			native.collectInvocations(composed.bodyAst, encoded, bodyCtx),
		);
		const bodyResolved = this.#invokeHelpers(bodyTape, validated, absPath);
		const bodyHtml = callNative(() =>
			native.renderAst(composed.bodyAst, encoded, bodyResolved, bodyCtx),
		);

		if (composed.layoutAst === undefined) {
			return bodyHtml;
		}

		const layoutAst = composed.layoutAst;
		const layoutName = composed.layoutName ?? validated;
		const layoutPath = composed.layoutAbsPath ?? absPath;
		// Layout collect ctx omits bodyHtml (slots carry no helpers); render ctx
		// injects it. Both walk identically so the tape aligns.
		const layoutTape = callNative(() =>
			native.collectInvocations(layoutAst, encoded, {
				partials,
				components,
				bodyHtml: undefined,
				templateName: layoutName,
				templatePath: layoutPath,
			}),
		);
		const layoutResolved = this.#invokeHelpers(
			layoutTape,
			layoutName,
			layoutPath,
		);
		return callNative(() =>
			native.renderAst(layoutAst, encoded, layoutResolved, {
				partials,
				components,
				bodyHtml,
				templateName: layoutName,
				templatePath: layoutPath,
			}),
		);
	}

	renderString(
		source: string,
		data: Readonly<Record<string, unknown>>,
	): string {
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
		const ast = callNative(() =>
			native.parseTemplate(normalisedSource, [...this.#helperNames]),
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

		const ctx: NapiRenderContext = {
			partials: {},
			components: {},
			bodyHtml: undefined,
			templateName: undefined,
			templatePath: undefined,
		};
		const encoded = encodeData(data);
		const tape = callNative(() => native.collectInvocations(ast, encoded, ctx));
		const resolved = this.#invokeHelpers(tape, undefined, undefined);
		return callNative(() => native.renderAst(ast, encoded, resolved, ctx));
	}

	// Invoke each collected helper TS-side in tape order, producing the resolved
	// values the renderer consumes. Mirrors the old `render.ts` Call-arm
	// contract: SafeString → raw; null/undefined → ""; non-string/SafeString or
	// a throw / thenable → E_INKER_HELPER_THROW (preserving InkerRenderError
	// passthrough + cause chain).
	#invokeHelpers(
		tape: readonly NapiInvocation[],
		templateName: string | undefined,
		templatePath: string | undefined,
	): NapiHelperResult[] {
		const out: NapiHelperResult[] = [];
		for (const inv of tape) {
			const helper = this.#helpers.get(inv.name);
			if (helper === undefined) {
				throw new InkerRenderError(
					"E_INKER_UNKNOWN_HELPER",
					`Helper '${inv.name}' is not registered in this Templates instance`,
					{ templatePath, templateName, expression: inv.name },
				);
			}
			let result: string | SafeString;
			let thenProp: unknown;
			try {
				result = helper(...inv.args);
				if (result !== null && typeof result === "object") {
					thenProp = Reflect.get(result, "then");
				}
			} catch (cause) {
				if (cause instanceof InkerRenderError) throw cause;
				const message = cause instanceof Error ? cause.message : String(cause);
				throw new InkerRenderError(
					"E_INKER_HELPER_THROW",
					`Helper '${inv.name}' threw: ${message}`,
					{ templatePath, templateName, expression: inv.name },
					{ cause },
				);
			}
			if (typeof thenProp === "function") {
				throw new InkerRenderError(
					"E_INKER_HELPER_THROW",
					`Helper '${inv.name}' returned a Promise/thenable — Inker renderers are synchronous (D2)`,
					{ templatePath, templateName, expression: inv.name },
				);
			}
			if (result instanceof SafeString) {
				out.push({ value: result.value, isSafe: true });
			} else if (result === null || result === undefined) {
				out.push({ value: "", isSafe: false });
			} else if (typeof result === "string") {
				out.push({ value: result, isSafe: false });
			} else {
				throw new InkerRenderError(
					"E_INKER_HELPER_THROW",
					`Helper '${inv.name}' returned ${typeof result} — Inker helpers must return string | SafeString | null | undefined (D2)`,
					{ templatePath, templateName, expression: inv.name },
				);
			}
		}
		return out;
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
			let realPath: string;
			try {
				// `.native` to match validateRoot's canonical form (same OS realpath)
				// so 8.3-short-name / casing differences don't trip containment.
				realPath = fs.realpathSync.native(absPath);
			} catch (cause) {
				throw wrapFsError(cause, absPath, validatedName);
			}
			if (realPath !== absPath) {
				const rel = path.relative(root, realPath);
				if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
					throw new InkerRenderError(
						"E_INKER_INVALID_PATH",
						`Resolved template path escapes the templates root via symlink: ${realPath} is outside ${root}`,
						{ templatePath: realPath, templateName: validatedName },
					);
				}
			}
			try {
				source = await handle.readFile("utf8");
			} catch (cause) {
				throw wrapFsError(cause, absPath, validatedName);
			}
		} finally {
			await handle.close();
		}

		// T4: strip leading UTF-8 BOM if present. Windows editors (Notepad)
		// commonly insert it; lex sees it as a Text token, defeating the
		// "first non-stripped node must be Layout" composition rule and
		// silently treating `@layout()` as body content.
		if (source.charCodeAt(0) === 0xfeff) {
			source = source.slice(1);
		}

		const ast = callNative(() =>
			getNative().parseTemplate(source, [...this.#helperNames]),
		);

		// T7: only populate the cache if the generation is unchanged. If
		// clearCache() was called during the await chain above, the new
		// generation discards this write — the next render() starts fresh.
		if (this.#cacheGeneration === loadGeneration) {
			this.#cache.set(cacheKey, { ast, mtimeMs: currentMtime });
		}
		return ast;
	}

	async #compose(
		entryAst: NapiInkerAst,
		entryName: string,
		entryAbsPath: string,
		includeStack: Set<string>,
	): Promise<ComposedTemplate> {
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
		await this.#resolvePartialsIn(
			entryInfo.partials,
			partialAsts,
			componentAsts,
			includeStack,
			entryAbsPath,
		);
		await this.#resolveComponentsIn(
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
			layoutAst = await this.#loadAst(
				layoutAbsPath,
				layoutValidated,
				layoutRoot,
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
			await this.#resolvePartialsIn(
				layoutInfo.partials,
				partialAsts,
				componentAsts,
				includeStack,
				layoutAbsPath,
			);
			await this.#resolveComponentsIn(
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

	async #resolvePartialsIn(
		refs: readonly NapiNodeRef[],
		partialAsts: Map<string, NapiInkerAst>,
		componentAsts: Map<string, NapiInkerAst>,
		includeStack: Set<string>,
		hostAbsPath: string,
	): Promise<void> {
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
				partialAst = await this.#loadAst(
					partialAbsPath,
					partialValidated,
					partialRoot,
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
				await this.#resolvePartialsIn(
					info.partials,
					partialAsts,
					componentAsts,
					includeStack,
					partialAbsPath,
				);
				await this.#resolveComponentsIn(
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

	async #resolveComponentsIn(
		refs: readonly NapiNodeRef[],
		partialAsts: Map<string, NapiInkerAst>,
		componentAsts: Map<string, NapiInkerAst>,
		includeStack: Set<string>,
		hostAbsPath: string,
	): Promise<void> {
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
				componentAst = await this.#loadAst(
					componentAbsPath,
					componentValidated,
					componentRoot,
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
				await this.#resolveComponentsIn(
					info.components,
					partialAsts,
					componentAsts,
					includeStack,
					componentAbsPath,
				);
				await this.#resolvePartialsIn(
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
