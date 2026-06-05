// PATTERN: copy-and-rename for 55.2/55.3/55.4 — Rust hot-path packages.
//
// Loads the native `inker-engine-napi` binary built by `scripts/copy-napi.mjs`
// and re-throws load failures as `E_INKER_NAPI_REQUIRED` per cerebrum
// NAPI-loader pattern (2026-04-27) — actionable hint points at
// `pnpm --filter @c9up/inker build:napi`.
//
// Per cerebrum 2026-04-15 there is NO JS fallback. If the binary fails to
// load, consumers get a typed error. Zero `as` / `any` per cerebrum 2026-05-04.

import { createRequire } from "node:module";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";
import { type InkerErrorCode, InkerRenderError } from "./InkerRenderError.js";

const SUFFIX_MAP: Readonly<Record<string, string>> = {
	"linux-x64": "linux-x64-gnu",
	"linux-arm64": "linux-arm64-gnu",
	"darwin-x64": "darwin-x64",
	"darwin-arm64": "darwin-arm64",
	"win32-x64": "win32-x64-msvc",
};

function platformSuffix(): string {
	const key = `${platform}-${arch}`;
	const suffix = SUFFIX_MAP[key];
	if (typeof suffix !== "string") {
		throw new InkerRenderError(
			"E_INKER_NAPI_REQUIRED",
			`Unsupported platform/arch '${key}' for @c9up/inker native binary. Supported: ${Object.keys(SUFFIX_MAP).join(", ")}.`,
		);
	}
	return suffix;
}

/** A `{% include %}` / `{% component %}` reference with source position. */
export interface NapiNodeRef {
	readonly name: string;
	readonly line: number;
	readonly column: number;
}

/** A `{{> name }}` slot reference. */
export interface NapiSlotRef {
	readonly name: string;
	readonly line: number;
	readonly column: number;
}

/** First disk-requiring node (`renderString` E_INKER_DISK_REQUIRED guard). */
export interface NapiDiskNodeRef {
	readonly kind: string;
	readonly name: string;
}

/** All composition metadata for one parsed AST (one NAPI call). */
export interface NapiComposeInfo {
	readonly hasLayout: boolean;
	readonly layoutName: string | null;
	readonly layoutLine: number | null;
	readonly layoutColumn: number | null;
	readonly slots: readonly NapiSlotRef[];
	readonly partials: readonly NapiNodeRef[];
	readonly components: readonly NapiNodeRef[];
	readonly hasContent: boolean;
	readonly firstDiskNode: NapiDiskNodeRef | null;
}

/** Opaque handle to a parsed Rust AST. */
export interface NapiInkerAst {
	readonly composeInfo: NapiComposeInfo;
}

/** One in-scope-evaluated helper invocation request (collect pass). */
export interface NapiInvocation {
	readonly id: number;
	readonly name: string;
	/** JSON array of the evaluated argument values. */
	readonly args: readonly unknown[];
}

/** One pre-resolved helper result (consumed in tape order by the renderer). */
export interface NapiHelperResult {
	readonly value: string;
	readonly isSafe: boolean;
}

export interface NapiRenderContext {
	readonly partials: Record<string, NapiInkerAst>;
	readonly components: Record<string, NapiInkerAst>;
	readonly bodyHtml: string | undefined;
	readonly templateName: string | undefined;
	readonly templatePath: string | undefined;
}

interface NativeExports {
	readonly engineVersion: () => string;
	readonly parseTemplate: (
		source: string,
		helpers: readonly string[],
	) => NapiInkerAst;
	readonly collectInvocations: (
		ast: NapiInkerAst,
		data: unknown,
		ctx: NapiRenderContext,
	) => NapiInvocation[];
	readonly renderAst: (
		ast: NapiInkerAst,
		data: unknown,
		resolved: readonly NapiHelperResult[],
		ctx: NapiRenderContext,
	) => string;
}

function isNativeExports(value: unknown): value is NativeExports {
	if (value === null || typeof value !== "object") return false;
	return (
		typeof Reflect.get(value, "engineVersion") === "function" &&
		typeof Reflect.get(value, "parseTemplate") === "function" &&
		typeof Reflect.get(value, "collectInvocations") === "function" &&
		typeof Reflect.get(value, "renderAst") === "function"
	);
}

let cachedNative: NativeExports | undefined;

export function getNative(): NativeExports {
	if (cachedNative !== undefined) return cachedNative;

	const require = createRequire(import.meta.url);
	const here = fileURLToPath(import.meta.url);
	// `here` is `…/packages/inker/{src,dist}/loadNapi.ts|js`. The `.node` lives
	// one level up at `…/packages/inker/index.<suffix>.node`. `..` traversal
	// resolved via require (handles both dev `src/` and publish `dist/`).
	const suffix = platformSuffix();
	const candidates: readonly string[] = [`../index.${suffix}.node`];
	let loaded: unknown;
	let lastErr: unknown;
	for (const candidate of candidates) {
		try {
			loaded = require(candidate);
			break;
		} catch (err) {
			lastErr = err;
		}
	}
	if (loaded === undefined) {
		const causeMessage =
			lastErr instanceof Error ? lastErr.message : String(lastErr);
		// The prebuilt linux binaries target glibc (`-gnu`). On musl hosts (Alpine
		// containers) the `-gnu` binary fails to dlopen with a libc symbol error —
		// surface that explicitly rather than only pointing at the build step.
		const muslHint = suffix.endsWith("-gnu")
			? " If you are on Alpine/musl, note the prebuilt binaries target glibc (musl is not a supported target)."
			: "";
		throw new InkerRenderError(
			"E_INKER_NAPI_REQUIRED",
			`@c9up/inker native binary 'index.${suffix}.node' not found or failed to load near ${here} — run 'pnpm --filter @c9up/inker build:napi' to build it.${muslHint} Cause: ${causeMessage}`,
			undefined,
			{ cause: lastErr },
		);
	}
	if (!isNativeExports(loaded)) {
		throw new InkerRenderError(
			"E_INKER_NAPI_REQUIRED",
			`@c9up/inker native binary loaded but missing expected exports (engineVersion / parseTemplate / renderAst). Rebuild with 'pnpm --filter @c9up/inker build:napi'.`,
		);
	}
	cachedNative = loaded;
	return cachedNative;
}

/**
 * Shape of the JSON payload Rust packs into `napi::Error::from_reason`. Rust
 * guarantees `code` / `message` present; positional fields optional.
 */
interface NapiErrorPayload {
	readonly code: string;
	readonly message: string;
	readonly line?: number;
	readonly column?: number;
	readonly templateName?: string;
}

function readString(target: unknown, key: string): string | undefined {
	const v = Reflect.get(Object(target), key);
	return typeof v === "string" ? v : undefined;
}

function readNumber(target: unknown, key: string): number | undefined {
	const v = Reflect.get(Object(target), key);
	return typeof v === "number" ? v : undefined;
}

function isNapiErrorPayload(value: unknown): value is NapiErrorPayload {
	if (value === null || typeof value !== "object") return false;
	return (
		typeof Reflect.get(value, "code") === "string" &&
		typeof Reflect.get(value, "message") === "string"
	);
}

const CODE_MAP: Readonly<Record<string, InkerErrorCode>> = {
	E_INKER_TEMPLATE_NOT_FOUND: "E_INKER_TEMPLATE_NOT_FOUND",
	E_INKER_PARSE_ERROR: "E_INKER_PARSE_ERROR",
	E_INKER_UNKNOWN_IDENTIFIER: "E_INKER_UNKNOWN_IDENTIFIER",
	E_INKER_INVALID_PATH: "E_INKER_INVALID_PATH",
	E_INKER_UNCLOSED_INTERPOLATION: "E_INKER_UNCLOSED_INTERPOLATION",
	E_INKER_UNCLOSED_BLOCK_TAG: "E_INKER_UNCLOSED_BLOCK_TAG",
	E_INKER_UNKNOWN_DIRECTIVE: "E_INKER_UNKNOWN_DIRECTIVE",
	E_INKER_INVALID_LAYOUT_POSITION: "E_INKER_INVALID_LAYOUT_POSITION",
	E_INKER_DUPLICATE_LAYOUT: "E_INKER_DUPLICATE_LAYOUT",
	E_INKER_NESTED_LAYOUT_UNSUPPORTED: "E_INKER_NESTED_LAYOUT_UNSUPPORTED",
	E_INKER_LAYOUT_IN_PARTIAL: "E_INKER_LAYOUT_IN_PARTIAL",
	E_INKER_CIRCULAR_INCLUDE: "E_INKER_CIRCULAR_INCLUDE",
	E_INKER_MISSING_SLOT: "E_INKER_MISSING_SLOT",
	E_INKER_UNKNOWN_SLOT: "E_INKER_UNKNOWN_SLOT",
	E_INKER_DISK_REQUIRED: "E_INKER_DISK_REQUIRED",
	E_INKER_UNCLOSED_BLOCK: "E_INKER_UNCLOSED_BLOCK",
	E_INKER_UNMATCHED_BLOCK_END: "E_INKER_UNMATCHED_BLOCK_END",
	E_INKER_MISMATCHED_BLOCK_END: "E_INKER_MISMATCHED_BLOCK_END",
	E_INKER_INVALID_EXPRESSION: "E_INKER_INVALID_EXPRESSION",
	E_INKER_INVALID_ITERABLE: "E_INKER_INVALID_ITERABLE",
	E_INKER_UNKNOWN_HELPER: "E_INKER_UNKNOWN_HELPER",
	E_INKER_HELPER_THROW: "E_INKER_HELPER_THROW",
	E_INKER_NAPI_REQUIRED: "E_INKER_NAPI_REQUIRED",
};

/**
 * Translate a thrown value from a NAPI call into an `InkerRenderError`.
 * If it's already an `InkerRenderError` (helper threw and propagated), pass through.
 * If it's a `napi::Error` carrying our JSON envelope, reconstruct typed.
 * Otherwise wrap as parse error.
 */
export function napiThrowToInker(err: unknown): InkerRenderError {
	if (err instanceof InkerRenderError) return err;
	if (err instanceof Error) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(err.message);
		} catch {
			parsed = undefined;
		}
		if (isNapiErrorPayload(parsed)) {
			const code = CODE_MAP[parsed.code];
			if (code !== undefined) {
				return new InkerRenderError(
					code,
					parsed.message,
					{
						line: readNumber(parsed, "line"),
						column: readNumber(parsed, "column"),
						templateName: readString(parsed, "templateName"),
					},
					{ cause: err },
				);
			}
		}
		return new InkerRenderError(
			"E_INKER_PARSE_ERROR",
			`Native call failed: ${err.message}`,
			undefined,
			{ cause: err },
		);
	}
	return new InkerRenderError(
		"E_INKER_PARSE_ERROR",
		`Native call failed with non-Error: ${String(err)}`,
	);
}
