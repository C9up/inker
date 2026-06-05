//! Path-expression parser — mirrors `packages/inker/src/parsePath.ts` 1:1.
//!
//! Accepts dot/bracket member access only: `foo`, `foo.bar`, `items[0]`,
//! `data["x.y"]`, mixed `users[0].name`. Rejects optional chaining (`?.`),
//! adjacent dots, negative indices, leading-zero numerics, floats, and any
//! operator / call / template-literal form. Numeric indices are bound to
//! `Number.MAX_SAFE_INTEGER` (2^53−1) — encoded here as `u64::MAX_SAFE` since
//! `u32` is the AC4 hint but the TS contract is the wider bound.

use crate::error::{ErrorCode, InkerError};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "value")]
pub enum PathSegment {
	Key(String),
	Index(u64),
}

/// JS `Number.MAX_SAFE_INTEGER` = 2^53 − 1. Bracket-index parsing rejects
/// values above this so silent precision loss can't happen on the JS side.
pub const NUMBER_MAX_SAFE_INTEGER: u64 = (1u64 << 53) - 1;

static IDENT_START: Lazy<Regex> =
	Lazy::new(|| Regex::new(r"^[a-zA-Z_$]$").expect("static regex"));
static IDENT_CONT: Lazy<Regex> =
	Lazy::new(|| Regex::new(r"^[a-zA-Z0-9_$]$").expect("static regex"));

fn is_ident_start(c: char) -> bool {
	IDENT_START.is_match(&c.to_string())
}

fn is_ident_cont(c: char) -> bool {
	IDENT_CONT.is_match(&c.to_string())
}

fn is_digit(c: char) -> bool {
	c.is_ascii_digit()
}

fn fail(
	expression: &str,
	reason: impl Into<String>,
	line: u32,
	column: u32,
	offset: usize,
) -> InkerError {
	let reason = reason.into();
	InkerError::new(
		ErrorCode::ParseError,
		format!(
			"Expression '{}' is not a member path: {} (at character {} of the expression). Inker 53.1 only supports dot and bracket access — JS expressions arrive in 53.4. At line {}, column {}.",
			expression,
			reason,
			offset + 1,
			line,
			column
		),
	)
	.with_pos(line, column)
	.with_expr(expression)
}

fn read_bracket_string(
	chars: &[char],
	expression: &str,
	start: usize,
	quote: char,
	line: u32,
	column: u32,
) -> Result<(String, usize), InkerError> {
	let len = chars.len();
	let mut i = start;
	let mut out = String::new();
	while i < len {
		let c = chars[i];
		if c == '\\' {
			if i + 1 >= len {
				return Err(fail(
					expression,
					"unterminated escape inside bracket-string",
					line,
					column,
					i,
				));
			}
			let next = chars[i + 1];
			if next == quote || next == '\\' {
				out.push(next);
				i += 2;
				continue;
			}
			return Err(fail(
				expression,
				format!(
					"unsupported escape sequence '\\{next}' inside bracket-string (only \\{quote} and \\\\ allowed)"
				),
				line,
				column,
				i,
			));
		}
		if c == quote {
			return Ok((out, i + 1));
		}
		out.push(c);
		i += 1;
	}
	Err(fail(
		expression,
		"unterminated bracket-string",
		line,
		column,
		i,
	))
}

pub fn parse_path(
	expression: &str,
	line: u32,
	column: u32,
) -> Result<Vec<PathSegment>, InkerError> {
	let chars: Vec<char> = expression.chars().collect();
	let len = chars.len();

	if len == 0 {
		return Err(fail(expression, "empty path", line, column, 0));
	}

	let mut segments: Vec<PathSegment> = Vec::new();
	let mut i = 0usize;

	// Initial identifier.
	let first = chars[i];
	if !is_ident_start(first) {
		return Err(fail(
			expression,
			format!("expected identifier at offset {i}"),
			line,
			column,
			i,
		));
	}
	let ident_start = i;
	i += 1;
	while i < len && is_ident_cont(chars[i]) {
		i += 1;
	}
	segments.push(PathSegment::Key(chars[ident_start..i].iter().collect()));

	while i < len {
		let ch = chars[i];

		if ch == '.' {
			if i + 1 >= len {
				return Err(fail(
					expression,
					"trailing dot with no identifier",
					line,
					column,
					i,
				));
			}
			if chars[i + 1] == '.' {
				return Err(fail(expression, "adjacent dots", line, column, i));
			}
			if chars[i + 1] == '?' {
				return Err(fail(
					expression,
					"optional chaining (?.) is not supported in 53.1",
					line,
					column,
					i,
				));
			}
			i += 1;
			if i >= len || !is_ident_start(chars[i]) {
				return Err(fail(
					expression,
					format!("expected identifier at offset {i}"),
					line,
					column,
					i,
				));
			}
			let start = i;
			i += 1;
			while i < len && is_ident_cont(chars[i]) {
				i += 1;
			}
			segments.push(PathSegment::Key(chars[start..i].iter().collect()));
			continue;
		}

		if ch == '[' {
			i += 1;
			if i >= len {
				return Err(fail(
					expression,
					"unterminated bracket access",
					line,
					column,
					i,
				));
			}
			let inner = chars[i];
			if inner == '"' || inner == '\'' {
				let (value, next) =
					read_bracket_string(&chars, expression, i + 1, inner, line, column)?;
				i = next;
				if i >= len || chars[i] != ']' {
					return Err(fail(
						expression,
						"expected ']' after bracket-string",
						line,
						column,
						i,
					));
				}
				i += 1;
				segments.push(PathSegment::Key(value));
				continue;
			}
			if is_digit(inner) {
				let start = i;
				while i < len && is_digit(chars[i]) {
					i += 1;
				}
				let digits: String = chars[start..i].iter().collect();
				let next_ch = if i < len { Some(chars[i]) } else { None };
				if next_ch == Some('.') {
					return Err(fail(
						expression,
						"float index — only non-negative integers allowed in bracket access",
						line,
						column,
						i,
					));
				}
				if next_ch != Some(']') {
					return Err(fail(
						expression,
						format!(
							"expected ']' after numeric index, got '{}'",
							match next_ch {
								Some(c) => c.to_string(),
								None => "EOF".to_string(),
							}
						),
						line,
						column,
						i,
					));
				}
				if digits.len() > 1 && digits.starts_with('0') {
					return Err(fail(
						expression,
						format!(
							"invalid numeric index '{digits}' — leading zeros are not allowed"
						),
						line,
						column,
						start,
					));
				}
				// `digits` is all-ASCII-digit with no leading zero at this point,
				// so a parse failure can only be a `u64` overflow — which is
				// necessarily beyond Number.MAX_SAFE_INTEGER. Match the in-range
				// guard's diagnostic instead of the generic message (TS used
				// float parsing and always reported MAX_SAFE_INTEGER here).
				let value: u64 = digits.parse().map_err(|_| {
					fail(
						expression,
						format!(
							"numeric index '{digits}' exceeds Number.MAX_SAFE_INTEGER ({NUMBER_MAX_SAFE_INTEGER}) — precision would be silently lost"
						),
						line,
						column,
						start,
					)
				})?;
				if value > NUMBER_MAX_SAFE_INTEGER {
					return Err(fail(
						expression,
						format!(
							"numeric index '{digits}' exceeds Number.MAX_SAFE_INTEGER ({NUMBER_MAX_SAFE_INTEGER}) — precision would be silently lost"
						),
						line,
						column,
						start,
					));
				}
				i += 1;
				segments.push(PathSegment::Index(value));
				continue;
			}
			if inner == '-' {
				return Err(fail(
					expression,
					"negative integer index — only non-negative integers allowed",
					line,
					column,
					i,
				));
			}
			return Err(fail(
				expression,
				format!("invalid bracket content starting with '{inner}'"),
				line,
				column,
				i,
			));
		}

		return Err(fail(
			expression,
			format!("unexpected character '{ch}' — JS expressions arrive in 53.4"),
			line,
			column,
			i,
		));
	}

	Ok(segments)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn simple_identifier() {
		assert_eq!(
			parse_path("foo", 1, 1).unwrap(),
			vec![PathSegment::Key("foo".into())]
		);
	}

	#[test]
	fn dot_chain() {
		assert_eq!(
			parse_path("a.b.c", 1, 1).unwrap(),
			vec![
				PathSegment::Key("a".into()),
				PathSegment::Key("b".into()),
				PathSegment::Key("c".into()),
			]
		);
	}

	#[test]
	fn bracket_index() {
		assert_eq!(
			parse_path("items[42]", 1, 1).unwrap(),
			vec![PathSegment::Key("items".into()), PathSegment::Index(42)]
		);
	}

	#[test]
	fn bracket_string_double_quoted() {
		assert_eq!(
			parse_path(r#"data["x.y"]"#, 1, 1).unwrap(),
			vec![PathSegment::Key("data".into()), PathSegment::Key("x.y".into())]
		);
	}

	#[test]
	fn bracket_string_with_escape() {
		assert_eq!(
			parse_path(r#"d["a\"b"]"#, 1, 1).unwrap(),
			vec![PathSegment::Key("d".into()), PathSegment::Key("a\"b".into())]
		);
	}

	#[test]
	fn rejects_trailing_dot() {
		let e = parse_path("a.", 1, 1).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn rejects_optional_chaining() {
		let e = parse_path("a?.b", 1, 1).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn rejects_float_index() {
		let e = parse_path("a[1.5]", 1, 1).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn rejects_leading_zero_index() {
		let e = parse_path("a[007]", 1, 1).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn rejects_negative_index() {
		let e = parse_path("a[-1]", 1, 1).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn rejects_empty() {
		let e = parse_path("", 1, 1).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn rejects_call_form() {
		let e = parse_path("foo(x)", 1, 1).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn accepts_index_zero() {
		assert_eq!(
			parse_path("a[0]", 1, 1).unwrap(),
			vec![PathSegment::Key("a".into()), PathSegment::Index(0)]
		);
	}
}
