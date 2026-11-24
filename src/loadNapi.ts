// Loads inker's native engine: the local build (`index.<suffix>.node` at the
// package root, written by `scripts/copy-napi.mjs`) when there is one, else the
// platform package `@c9up/inker-<suffix>` the package manager installed as an
// optional dependency. A failure throws `E_INKER_NAPI_REQUIRED`, whose message
// says what to do and whose `cause` is the load error.
//
// There is no JavaScript fallback: without the engine, nothing renders.

import { arch, platform } from "node:process";
import type { Exception } from "@c9up/flare";
import * as errors from "./errors.js";
import {
	InkerError,
	type InkerErrorCode,
	isInkerException,
} from "./inkerError.js";
import {
	hasFunctions,
	loadNativeBinary,
	muslHint,
	supportedTargets,
} from "./vendor/nativeBinary.js";

/**
 * The npm name the platform packages derive from: `@c9up/inker-<suffix>`,
 * one per target, each an optional dependency pinned to this version.
 */
const PACKAGE_NAME = "@c9up/inker";

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
 * What this package calls on the engine, typed as the Rust declares it. The
 * guard checks the same calls at load: a declaration says what the Rust
 * promises, not what a stale binary shipped.
 */
const NATIVE_CALLS = ["parseTemplate", "astToJson", "openedPath"] as const;

type NativeExports = Pick<
	typeof import("./native/generated.js"),
	(typeof NATIVE_CALLS)[number]
>;

function isNativeExports(value: unknown): value is NativeExports {
	return hasFunctions(value, NATIVE_CALLS);
}

let cachedNative: NativeExports | undefined;

export function getNative(): NativeExports {
	if (cachedNative !== undefined) return cachedNative;

	// The resolution and the export check are shared; the refusal below stays
	// this package's own.
	const attempt = loadNativeBinary(isNativeExports, NATIVE_CALLS, {
		packageName: PACKAGE_NAME,
	});
	if (attempt.loaded) {
		cachedNative = attempt.binary;
		return cachedNative;
	}
	throw new errors.E_INKER_NAPI_REQUIRED(
		[
			"The inker Rust engine is required but not loaded.\n" +
				`  Fix: ${remedy(attempt.suffix, attempt.platformPackage)}`,
		],
		attempt.cause === undefined ? undefined : { cause: attempt.cause },
	);
}

/**
 * What to do about a missing engine, phrased for whoever has to fix it.
 *
 * An application installs the platform package; a checkout of inker builds
 * the local binary. The load error itself is not in here: it names paths on
 * the host, so it travels as the refusal's `cause` instead of its message.
 */
function remedy(
	suffix: string | undefined,
	platformPackage: string | undefined,
): string {
	if (suffix === undefined) {
		return `no prebuilt binary for ${platform}-${arch}; inker ships one for ${supportedTargets().join(", ")}.`;
	}
	if (platformPackage === undefined) {
		return `index.${suffix}.node failed to load. Rebuild it: cd packages/inker && pnpm build:napi`;
	}
	return (
		`install ${platformPackage} at the exact version of ${PACKAGE_NAME}: it is the optional dependency that carries the ${suffix} binary, ` +
		"and an install that omits optional dependencies skips it. " +
		`In a checkout of inker, build it instead: pnpm build:napi.${muslHint()}`
	);
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
	E_INKER_HELPER_THROW: "E_INKER_HELPER_THROW",
	E_INKER_NAPI_REQUIRED: "E_INKER_NAPI_REQUIRED",
};

/**
 * Translate a thrown value from a NAPI call into an inker error.
 * If it's already one of inker's (helper threw and propagated), pass through.
 * If it's a `napi::Error` carrying our JSON envelope, reconstruct typed.
 * Otherwise wrap as parse error.
 */
export function napiThrowToInker(err: unknown): Exception {
	if (isInkerException(err)) return err;
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
				return new InkerError(
					parsed.message,
					code,
					{
						line: readNumber(parsed, "line") ?? 0,
						col: readNumber(parsed, "column") ?? 0,
						filename: readString(parsed, "templateName") ?? "",
					},
					{ cause: err },
				);
			}
		}
		return new InkerError(
			`Native call failed: ${err.message}`,
			"E_INKER_PARSE_ERROR",
			{ line: 0, col: 0, filename: "" },
			{ cause: err },
		);
	}
	return new InkerError(
		`Native call failed with non-Error: ${String(err)}`,
		"E_INKER_PARSE_ERROR",
		{ line: 0, col: 0, filename: "" },
	);
}
