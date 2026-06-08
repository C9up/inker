//! `InkerError` — one variant per `InkerErrorCode` in
//! `packages/inker/src/InkerRenderError.ts` plus `NapiRequired` for the
//! binary-load failure path introduced by Story 55.1.
//!
//! The `code()` mapping is exhaustively pinned by [`tests::code_mapping`] so a
//! missing or misnamed variant surfaces at `cargo test` time, not at NAPI
//! boundary parsing time.

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Error, Serialize)]
pub struct InkerError {
	pub code: ErrorCode,
	pub message: String,
	pub line: Option<u32>,
	pub column: Option<u32>,
	pub template_name: Option<String>,
	pub expression: Option<String>,
}

impl std::fmt::Display for InkerError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "[{}] {}", self.code.as_str(), self.message)
	}
}

impl InkerError {
	pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
		Self {
			code,
			message: message.into(),
			line: None,
			column: None,
			template_name: None,
			expression: None,
		}
	}

	pub fn with_pos(mut self, line: u32, column: u32) -> Self {
		self.line = Some(line);
		self.column = Some(column);
		self
	}

	pub fn with_template(mut self, name: impl Into<String>) -> Self {
		self.template_name = Some(name.into());
		self
	}

	pub fn with_expr(mut self, expression: impl Into<String>) -> Self {
		self.expression = Some(expression.into());
		self
	}
}

/// 1:1 mirror of the `InkerErrorCode` TS union (22 codes pre-55.1) plus
/// `NapiRequired` (23rd, Story 55.1 §D55.1.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
	TemplateNotFound,
	ParseError,
	UnknownIdentifier,
	InvalidPath,
	UnclosedInterpolation,
	UnclosedBlockTag,
	UnknownDirective,
	InvalidLayoutPosition,
	DuplicateLayout,
	NestedLayoutUnsupported,
	LayoutInPartial,
	CircularInclude,
	MissingSlot,
	UnknownSlot,
	DiskRequired,
	UnclosedBlock,
	UnmatchedBlockEnd,
	MismatchedBlockEnd,
	InvalidExpression,
	InvalidIterable,
	UnknownHelper,
	HelperThrow,
	NapiRequired,
}

impl ErrorCode {
	/// Returns the TS string code (e.g. `"E_INKER_TEMPLATE_NOT_FOUND"`).
	/// Stable across the NAPI boundary — the TS-side `loadNapi.ts` reads this
	/// to reconstruct an `InkerRenderError` instance with the same `code`.
	pub fn as_str(self) -> &'static str {
		match self {
			ErrorCode::TemplateNotFound => "E_INKER_TEMPLATE_NOT_FOUND",
			ErrorCode::ParseError => "E_INKER_PARSE_ERROR",
			ErrorCode::UnknownIdentifier => "E_INKER_UNKNOWN_IDENTIFIER",
			ErrorCode::InvalidPath => "E_INKER_INVALID_PATH",
			ErrorCode::UnclosedInterpolation => "E_INKER_UNCLOSED_INTERPOLATION",
			ErrorCode::UnclosedBlockTag => "E_INKER_UNCLOSED_BLOCK_TAG",
			ErrorCode::UnknownDirective => "E_INKER_UNKNOWN_DIRECTIVE",
			ErrorCode::InvalidLayoutPosition => "E_INKER_INVALID_LAYOUT_POSITION",
			ErrorCode::DuplicateLayout => "E_INKER_DUPLICATE_LAYOUT",
			ErrorCode::NestedLayoutUnsupported => "E_INKER_NESTED_LAYOUT_UNSUPPORTED",
			ErrorCode::LayoutInPartial => "E_INKER_LAYOUT_IN_PARTIAL",
			ErrorCode::CircularInclude => "E_INKER_CIRCULAR_INCLUDE",
			ErrorCode::MissingSlot => "E_INKER_MISSING_SLOT",
			ErrorCode::UnknownSlot => "E_INKER_UNKNOWN_SLOT",
			ErrorCode::DiskRequired => "E_INKER_DISK_REQUIRED",
			ErrorCode::UnclosedBlock => "E_INKER_UNCLOSED_BLOCK",
			ErrorCode::UnmatchedBlockEnd => "E_INKER_UNMATCHED_BLOCK_END",
			ErrorCode::MismatchedBlockEnd => "E_INKER_MISMATCHED_BLOCK_END",
			ErrorCode::InvalidExpression => "E_INKER_INVALID_EXPRESSION",
			ErrorCode::InvalidIterable => "E_INKER_INVALID_ITERABLE",
			ErrorCode::UnknownHelper => "E_INKER_UNKNOWN_HELPER",
			ErrorCode::HelperThrow => "E_INKER_HELPER_THROW",
			ErrorCode::NapiRequired => "E_INKER_NAPI_REQUIRED",
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn code_mapping_is_exhaustive_and_byte_identical_to_ts() {
		// If a variant is added to ErrorCode without a `code()` arm, the match
		// becomes non-exhaustive and this file fails to compile — so the
		// failure mode is earlier than this test. This test just pins the
		// string bytes 1:1 to the TS InkerErrorCode union (T2.10 / AC8).
		let pairs: &[(ErrorCode, &str)] = &[
			(ErrorCode::TemplateNotFound, "E_INKER_TEMPLATE_NOT_FOUND"),
			(ErrorCode::ParseError, "E_INKER_PARSE_ERROR"),
			(ErrorCode::UnknownIdentifier, "E_INKER_UNKNOWN_IDENTIFIER"),
			(ErrorCode::InvalidPath, "E_INKER_INVALID_PATH"),
			(ErrorCode::UnclosedInterpolation, "E_INKER_UNCLOSED_INTERPOLATION"),
			(ErrorCode::UnclosedBlockTag, "E_INKER_UNCLOSED_BLOCK_TAG"),
			(ErrorCode::UnknownDirective, "E_INKER_UNKNOWN_DIRECTIVE"),
			(ErrorCode::InvalidLayoutPosition, "E_INKER_INVALID_LAYOUT_POSITION"),
			(ErrorCode::DuplicateLayout, "E_INKER_DUPLICATE_LAYOUT"),
			(ErrorCode::NestedLayoutUnsupported, "E_INKER_NESTED_LAYOUT_UNSUPPORTED"),
			(ErrorCode::LayoutInPartial, "E_INKER_LAYOUT_IN_PARTIAL"),
			(ErrorCode::CircularInclude, "E_INKER_CIRCULAR_INCLUDE"),
			(ErrorCode::MissingSlot, "E_INKER_MISSING_SLOT"),
			(ErrorCode::UnknownSlot, "E_INKER_UNKNOWN_SLOT"),
			(ErrorCode::DiskRequired, "E_INKER_DISK_REQUIRED"),
			(ErrorCode::UnclosedBlock, "E_INKER_UNCLOSED_BLOCK"),
			(ErrorCode::UnmatchedBlockEnd, "E_INKER_UNMATCHED_BLOCK_END"),
			(ErrorCode::MismatchedBlockEnd, "E_INKER_MISMATCHED_BLOCK_END"),
			(ErrorCode::InvalidExpression, "E_INKER_INVALID_EXPRESSION"),
			(ErrorCode::InvalidIterable, "E_INKER_INVALID_ITERABLE"),
			(ErrorCode::UnknownHelper, "E_INKER_UNKNOWN_HELPER"),
			(ErrorCode::HelperThrow, "E_INKER_HELPER_THROW"),
			(ErrorCode::NapiRequired, "E_INKER_NAPI_REQUIRED"),
		];
		assert_eq!(pairs.len(), 23, "23 codes total post-55.1");
		for (code, expected) in pairs {
			assert_eq!(code.as_str(), *expected);
		}
	}
}
