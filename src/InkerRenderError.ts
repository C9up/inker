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
	| "E_INKER_UNKNOWN_HELPER"
	| "E_INKER_HELPER_THROW"
	| "E_INKER_NAPI_REQUIRED";

export interface InkerErrorContext {
	readonly templatePath?: string;
	readonly templateName?: string;
	readonly line?: number;
	readonly column?: number;
	readonly expression?: string;
}

export class InkerRenderError extends Error {
	readonly code: InkerErrorCode;
	readonly context: Readonly<InkerErrorContext>;

	constructor(
		code: InkerErrorCode,
		message: string,
		context?: InkerErrorContext,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "InkerRenderError";
		this.code = code;
		this.context = Object.freeze({ ...(context ?? {}) });
	}
}
