/**
 * The error of a template: Edge's `EdgeError` (package `edge-error`), under
 * inker's name. Errors raised by a call rather than by a template (a missing
 * provider, a bad config value, a name refused before any template is read)
 * are the `errors` namespace instead, in `errors.ts`.
 */

import { Exception } from "@c9up/flare";

/** Every code an {@link InkerError} carries. */
export type InkerErrorCode =
	| "E_INKER_TEMPLATE_NOT_FOUND"
	| "E_INKER_PARSE_ERROR"
	| "E_INKER_UNKNOWN_IDENTIFIER"
	| "E_INKER_INVALID_PATH"
	| "E_INKER_UNCLOSED_INTERPOLATION"
	| "E_INKER_UNCLOSED_BLOCK_TAG"
	| "E_INKER_UNKNOWN_DIRECTIVE"
	| "E_INKER_INVALID_LAYOUT_POSITION"
	| "E_INKER_DUPLICATE_LAYOUT"
	| "E_INKER_NESTED_LAYOUT_UNSUPPORTED"
	| "E_INKER_LAYOUT_IN_PARTIAL"
	| "E_INKER_CIRCULAR_INCLUDE"
	| "E_INKER_MISSING_SLOT"
	| "E_INKER_UNKNOWN_SLOT"
	| "E_INKER_DISK_REQUIRED"
	| "E_INKER_UNCLOSED_BLOCK"
	| "E_INKER_UNMATCHED_BLOCK_END"
	| "E_INKER_MISMATCHED_BLOCK_END"
	| "E_INKER_INVALID_EXPRESSION"
	| "E_INKER_INVALID_ITERABLE"
	| "E_INKER_HELPER_THROW"
	| "E_INKER_UNKNOWN_TAG"
	/** `@dd(expr)`: the render was deliberately stopped after dumping. */
	| "E_INKER_DUMP_DIE"
	/** `@newError(...)`: an error the template author raised on purpose. */
	| "E_INKER_TEMPLATE_ERROR"
	/** `await` reached a place that renders synchronously (a custom tag's body,
	 * `renderString`). Use `render()`, whose walk can suspend. */
	| "E_INKER_ASYNC_NOT_SUPPORTED"
	/** The render nested too deep: runaway component/partial recursion, or a
	 * helper that overflowed the stack. */
	| "E_INKER_RENDER_DEPTH"
	/** The native engine reported that it cannot run. */
	| "E_INKER_NAPI_REQUIRED";

/**
 * Where in a template an error arose: EdgeError's options. `line` and `col`
 * are 1-based, 0 when the failure has no line of its own (a layout that
 * cannot be found, a nesting limit); `filename` is the template's name, and
 * an empty string for a source string rendered without a label.
 */
export interface InkerErrorPosition {
	line: number;
	col: number;
	filename: string;
}

/**
 * An error at a position in a template, shaped as Edge's `EdgeError`: the
 * same constructor, the same `line` / `col` / `filename`, and the same extra
 * stack frame pointing at the template.
 *
 * One deliberate difference: it extends flare's `Exception` rather than
 * `Error`, so it carries `status` (500) like every ream error and the
 * application's exception handler treats it as one of them.
 */
export class InkerError extends Exception {
	declare code: InkerErrorCode;
	line: number;
	col: number;
	filename: string;

	constructor(
		message: string,
		code: InkerErrorCode,
		options: InkerErrorPosition,
		errorOptions?: ErrorOptions,
	) {
		super(message, { ...errorOptions, code });
		this.code = code;
		this.line = options.line;
		this.col = options.col;
		this.filename = options.filename;
		const stack = (this.stack ?? "").split("\n");
		stack.splice(1, 0, templateFrame(this));
		this.stack = stack.join("\n");
	}
}

/** Whether `value` is an error of a template. */
export function isInkerError(value: unknown): value is InkerError {
	return value instanceof InkerError;
}

/**
 * Whether `value` is any of inker's own errors: an {@link InkerError}, or one
 * of the `errors` namespace a helper raised. The render lets these through as
 * they are, where any other error is turned into a template error.
 */
export function isInkerException(
	value: unknown,
): value is Exception & { code: string } {
	return (
		value instanceof Exception &&
		typeof value.code === "string" &&
		value.code.startsWith("E_INKER_")
	);
}

/** The stack frame EdgeError adds, pointing at the template. */
function templateFrame(position: InkerErrorPosition): string {
	return `    at anonymous (${position.filename}:${position.line}:${position.col})`;
}

/**
 * The same error, placed in a template: `position.filename` when the error
 * names none (a source string has no name of its own, so the caller's label
 * is what tells a reader WHICH template failed), and `position`'s line and
 * column when it had none. An error already placed is returned as it is; a
 * placed copy keeps the original's stack, with its template frame updated.
 */
export function inTemplate(
	err: InkerError,
	position: InkerErrorPosition,
): InkerError {
	if (err.filename !== "") return err;
	const placed: InkerErrorPosition =
		err.line === 0
			? position
			: { line: err.line, col: err.col, filename: position.filename };
	if (
		placed.filename === err.filename &&
		placed.line === err.line &&
		placed.col === err.col
	) {
		return err;
	}
	const copy = new InkerError(
		err.message,
		err.code,
		placed,
		"cause" in err ? { cause: err.cause } : undefined,
	);
	if (err.help !== undefined) copy.help = err.help;
	if (err.stack !== undefined) {
		copy.stack = err.stack.replace(templateFrame(err), templateFrame(copy));
	}
	return copy;
}
