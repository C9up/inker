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

/**
 * The engine's types, as the Rust declares them.
 *
 * Derived from `./native/generated.js` — written by `pnpm build:napi-types`
 * from napi-derive's own `type-def` output — rather than mirrored here by
 * hand, where nothing notices the Rust changing a field. It already had:
 * `layoutName` and `firstDiskNode` were declared `| null`, but napi-rs maps
 * `Option<T>` on an `#[napi(object)]` to an ABSENT field, so the value is
 * `undefined` and a `=== null` guard against it never fired.
 */
export type NapiNodeRef = import("./native/generated.js").NodeRefNapi;
export type NapiSlotRef = import("./native/generated.js").SlotRefNapi;
export type NapiDiskNodeRef = import("./native/generated.js").DiskNodeRefNapi;
export type NapiComposeInfo = import("./native/generated.js").ComposeInfoNapi;
export type NapiInkerAst = import("./native/generated.js").InkerAst;

/**
 * The engine's surface, as the Rust declares it. The runtime guard below still
 * checks the four exports are actually there: a declaration says what the Rust
 * promises, not what a stale binary shipped.
 */
type NativeExports = typeof import("./native/generated.js");

function isNativeExports(value: unknown): value is NativeExports {
	if (value === null || typeof value !== "object") return false;
	return (
		typeof Reflect.get(value, "engineVersion") === "function" &&
		typeof Reflect.get(value, "parseTemplate") === "function" &&
		typeof Reflect.get(value, "astToJson") === "function" &&
		typeof Reflect.get(value, "parseTemplateJson") === "function"
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
