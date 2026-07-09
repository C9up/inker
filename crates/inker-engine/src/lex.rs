//! Tokenizer — Edge-syntax control flow (Epic 62 / story 62.1).
//!
//! Produces five token kinds:
//!   - `Text` — verbatim source between control structures.
//!   - `InterpEscaped` — `{{ expr }}` (escape-by-default; trim markers `{{- -}}`).
//!   - `InterpRaw` — `{{{ expr }}}` (raw HTML pass-through).
//!   - `BlockTag` — `@keyword(args)` / `@keyword` / `@endkeyword` / `@!component(args)`
//!     (Edge `@`-tags; the un-`@`ed, paren-unwrapped inner `keyword args` is kept
//!     for parse_block_tag.rs). `@...` is no longer recognised.
//!   - `SlotPlaceholder` — `{{> name }}` (layout body slot).
//!
//! `@`-tag disambiguation follows Edge: `@word` is a block tag ONLY when `word`
//! (or `!word` / `endword`) is a known block keyword; any other `@…` (CSS
//! `@media`/`@keyframes`, `me@example.com`, JS `@decorator`) is literal text.
//!
//! Escapes (Edge parity): `@@` → literal `@`; `@{{` → literal `{{` (suppresses the
//! interpolation). The old backslash escapes (`\{{`, `\}}`, `\@`,(`\)`) are gone —
//! `@`/`` are ordinary text now and need no escaping.
//!
//! Position tracking is character-by-character. Templates are ASCII-heavy, so
//! char-count and UTF-16-code-unit-count diverge only on non-BMP scalars (4-byte
//! emoji etc.) — accepted divergence per DNR `feedback_no_drift_noise`; the
//! byte-parity suite uses ASCII fixtures.

use crate::error::{ErrorCode, InkerError};
use once_cell::sync::Lazy;
use regex::Regex;

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
	Text {
		value: String,
		line: u32,
		column: u32,
	},
	InterpEscaped {
		expression: String,
		line: u32,
		column: u32,
		expr_line: u32,
		expr_column: u32,
	},
	InterpRaw {
		expression: String,
		line: u32,
		column: u32,
		expr_line: u32,
		expr_column: u32,
	},
	BlockTag {
		raw: String,
		line: u32,
		column: u32,
	},
	SlotPlaceholder {
		name: String,
		line: u32,
		column: u32,
	},
}

#[derive(Debug, Default, Clone)]
pub struct LexOptions {
	pub template_path: Option<String>,
	/// Runtime-registered custom tag names (Edge `registerTag`). `@<name>` lexes
	/// as a block tag when `name` is a built-in OR in this set.
	pub custom_tags: std::collections::HashSet<String>,
}

static SLOT_NAME_RE: Lazy<Regex> = Lazy::new(|| {
	Regex::new(r"^[a-zA-Z_][a-zA-Z0-9_-]*$").expect("static regex compiles")
});

#[derive(Debug, Clone, Copy)]
struct Cursor {
	line: u32,
	column: u32,
}

fn advance(cursor: &mut Cursor, ch: char) {
	if ch == '\n' {
		cursor.line += 1;
		cursor.column = 1;
	} else if ch == '\r' {
		// CR invisible to position tracking — a following LF resets the line.
		// A lone CR (classic-Mac) collapses subsequent text onto the same line.
	} else {
		cursor.column += 1;
	}
}

/// Block-tag keywords recognised at the `@` sigil. `@word` is a tag ONLY when
/// `word` is in this set (Edge parity — everything else, incl. CSS `@media` and
/// e-mail `@host`, is literal text). `section`/`endsection`/`super` are listed so
/// `@section` lexes as a tag and the PARSER rejects it cleanly (reserved for the
/// 62.3 layout-model story) rather than leaking through as text.
fn is_block_keyword(word: &str) -> bool {
	matches!(
		word,
		"if" | "elseif"
			| "else" | "endif"
			| "unless" | "endunless"
			| "each" | "endeach"
			| "let" | "include"
			| "includeIf" | "component"
			| "endcomponent" | "slot"
			| "endslot" | "layout"
			| "section" | "endsection"
			| "super" | "eval"
			| "dump"
	)
}

/// Read an ASCII identifier (`[A-Za-z][A-Za-z0-9]*`) starting at `i`. Returns the
/// word and the index one past its last char. Used to peek the keyword after an
/// `@` (or `@!`) sigil. Empty when `chars[i]` is not an identifier start.
fn read_ident(chars: &[char], i: usize) -> (String, usize) {
	let len = chars.len();
	let mut j = i;
	if j >= len || !(chars[j].is_ascii_alphabetic() || chars[j] == '_') {
		return (String::new(), i);
	}
	let mut out = String::new();
	while j < len && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
		out.push(chars[j]);
		j += 1;
	}
	(out, j)
}

// The `flush_text!` macro reassigns the text-start cursor after every flush so
// the NEXT text run starts at the right position; on the final flush (after the
// loop) that reassignment is legitimately dead. Suppress the macro-generated
// false positive rather than contort the macro.
#[allow(unused_assignments)]
pub fn lex(source: &str, options: &LexOptions) -> Result<Vec<Token>, InkerError> {
	// Char-indexed view so `chars[i + N]` is O(1) and mirrors TS's
	// `source[i + N]` byte-indexed access for ASCII templates.
	let chars: Vec<char> = source.chars().collect();
	let len = chars.len();
	let mut tokens: Vec<Token> = Vec::new();
	let mut cursor = Cursor { line: 1, column: 1 };
	let mut i = 0usize;

	let mut text_start_line = cursor.line;
	let mut text_start_column = cursor.column;
	let mut text_buf = String::new();
	// Set by a right-trim interpolation `{{ … -}}`; trims the leading whitespace
	// of the following text run (Edge whitespace-control parity).
	let mut trim_pending_left = false;

	macro_rules! flush_text {
		($cursor:expr, $start_line:expr, $start_col:expr, $buf:expr, $toks:expr) => {{
			if !$buf.is_empty() {
				$toks.push(Token::Text {
					value: std::mem::take(&mut $buf),
					line: $start_line,
					column: $start_col,
				});
			}
			$start_line = $cursor.line;
			$start_col = $cursor.column;
		}};
	}

	while i < len {
		// Right-trim carry-over from a `{{ … -}}`: swallow the leading whitespace
		// of this text run before doing anything else.
		if trim_pending_left {
			while i < len
				&& (chars[i] == ' '
					|| chars[i] == '\t'
					|| chars[i] == '\r'
					|| chars[i] == '\n')
			{
				advance(&mut cursor, chars[i]);
				i += 1;
			}
			trim_pending_left = false;
			text_start_line = cursor.line;
			text_start_column = cursor.column;
			if i >= len {
				break;
			}
		}
		let ch = chars[i];

		// Edge `@` sigil: escapes (`@@`, `@{{`) + block tags (`@keyword(args)`,
		// `@keyword`, `@endkeyword`, `@!component(args)`). A `@word` that is not a
		// known block keyword is literal text (falls through below).
		if ch == '@' {
			// `@@` → literal `@`.
			if i + 1 < len && chars[i + 1] == '@' {
				text_buf.push('@');
				advance(&mut cursor, '@');
				advance(&mut cursor, '@');
				i += 2;
				continue;
			}
			// `@{{` → literal `{{` (suppress interpolation).
			if i + 2 < len && chars[i + 1] == '{' && chars[i + 2] == '{' {
				text_buf.push_str("{{");
				advance(&mut cursor, '@');
				advance(&mut cursor, '{');
				advance(&mut cursor, '{');
				i += 3;
				continue;
			}
			// `@[!]keyword` — a block tag only when `keyword` is known.
			let self_closing = i + 1 < len && chars[i + 1] == '!';
			let word_start = if self_closing { i + 2 } else { i + 1 };
			let (word, after_word) = read_ident(&chars, word_start);
			// `@!` is only valid for `component`; `@!other` is literal.
			if !word.is_empty()
				&& (is_block_keyword(&word) || options.custom_tags.contains(word.as_str()))
				&& (!self_closing || word == "component")
			{
				flush_text!(cursor, text_start_line, text_start_column, text_buf, tokens);
				let open_line = cursor.line;
				let open_column = cursor.column;
				// Advance over `@`, optional `!`, and the keyword chars.
				while i < after_word {
					advance(&mut cursor, chars[i]);
					i += 1;
				}
				// Optional balanced `( … )` argument span (string-aware + nested).
				let mut args = String::new();
				if i < len && chars[i] == '(' {
					advance(&mut cursor, '(');
					i += 1;
					let mut depth = 1usize;
					let mut string_delim: Option<char> = None;
					let mut closed = false;
					while i < len {
						let c = chars[i];
						if let Some(d) = string_delim {
							if c == '\\' && i + 1 < len {
								args.push(c);
								args.push(chars[i + 1]);
								advance(&mut cursor, c);
								advance(&mut cursor, chars[i + 1]);
								i += 2;
								continue;
							}
							if c == d {
								string_delim = None;
							}
							args.push(c);
							advance(&mut cursor, c);
							i += 1;
							continue;
						}
						if c == '"' || c == '\'' {
							string_delim = Some(c);
							args.push(c);
							advance(&mut cursor, c);
							i += 1;
							continue;
						}
						if c == '(' {
							depth += 1;
						} else if c == ')' {
							depth -= 1;
							if depth == 0 {
								advance(&mut cursor, ')');
								i += 1;
								closed = true;
								break;
							}
						}
						args.push(c);
						advance(&mut cursor, c);
						i += 1;
					}
					if !closed {
						return Err(make_err(
							ErrorCode::UnclosedBlockTag,
							format!(
								"Unclosed '@{}(' at line {}, column {}",
								word, open_line, open_column
							),
							open_line,
							open_column,
							options,
						));
					}
				}
				// Reconstruct the `raw` parse_block_tag expects: `[!]keyword args`,
				// args paren-unwrapped + trimmed. Self-closing component keeps `!`.
				let kw = if self_closing {
					format!("!{word}")
				} else {
					word.clone()
				};
				let args_trimmed = args.trim();
				let raw = if args_trimmed.is_empty() {
					kw
				} else {
					format!("{kw} {args_trimmed}")
				};
				tokens.push(Token::BlockTag {
					raw,
					line: open_line,
					column: open_column,
				});
				// Edge trims ONE newline immediately after a block tag, so a tag on
				// its own line injects no blank line into the output.
				if i < len && chars[i] == '\r' {
					advance(&mut cursor, '\r');
					i += 1;
				}
				if i < len && chars[i] == '\n' {
					advance(&mut cursor, '\n');
					i += 1;
				}
				text_start_line = cursor.line;
				text_start_column = cursor.column;
				continue;
			}
			// Not a known tag — `@` is literal; fall through to text accumulation.
		}

		// Comment: {{-- ... --}} (Edge parity). Stripped entirely — emits no
		// token and no output, does not touch the data tree. Balanced against
		// the first `--}}`; an unterminated comment is a hard lex error so a
		// stray `{{--` cannot silently swallow the rest of the template.
		if ch == '{'
			&& i + 3 < len
			&& chars[i + 1] == '{'
			&& chars[i + 2] == '-'
			&& chars[i + 3] == '-'
		{
			flush_text!(cursor, text_start_line, text_start_column, text_buf, tokens);
			let open_line = cursor.line;
			let open_column = cursor.column;
			advance(&mut cursor, '{');
			advance(&mut cursor, '{');
			advance(&mut cursor, '-');
			advance(&mut cursor, '-');
			i += 4;
			let mut closed = false;
			while i < len {
				let c = chars[i];
				if c == '-'
					&& i + 3 < len
					&& chars[i + 1] == '-'
					&& chars[i + 2] == '}'
					&& chars[i + 3] == '}'
				{
					advance(&mut cursor, '-');
					advance(&mut cursor, '-');
					advance(&mut cursor, '}');
					advance(&mut cursor, '}');
					i += 4;
					closed = true;
					break;
				}
				advance(&mut cursor, c);
				i += 1;
			}
			if !closed {
				return Err(make_err(
					ErrorCode::UnclosedInterpolation,
					format!(
						"Unclosed comment (missing '--}}}}') at line {}, column {}",
						open_line, open_column
					),
					open_line,
					open_column,
					options,
				));
			}
			text_start_line = cursor.line;
			text_start_column = cursor.column;
			continue;
		}

		// `@…` is no longer a control structure — it is ordinary text now
		// (Edge uses `@`-tags, handled at the `@` sigil above). No branch here.

		// Interpolation open: {{ ... }} / {{{ ... }}} / slot {{> ... }}
		if ch == '{' && i + 1 < len && chars[i + 1] == '{' {
			flush_text!(cursor, text_start_line, text_start_column, text_buf, tokens);
			let open_line = cursor.line;
			let open_column = cursor.column;
			let is_raw = i + 2 < len && chars[i + 2] == '{';

			if is_raw {
				advance(&mut cursor, '{');
				advance(&mut cursor, '{');
				advance(&mut cursor, '{');
				i += 3;
			} else {
				advance(&mut cursor, '{');
				advance(&mut cursor, '{');
				i += 2;
			}

			// Left-trim `{{- … }}` / `{{{- … }}}`: a `-` right after the braces
			// strips the trailing whitespace of the preceding text run.
			if i < len && chars[i] == '-' {
				advance(&mut cursor, '-');
				i += 1;
				if let Some(Token::Text { value, .. }) = tokens.last_mut() {
					*value = value.trim_end().to_string();
					// Don't leave a zero-width Text node when the whole run was ws.
					if value.is_empty() {
						tokens.pop();
					}
				}
			}

			// Slot disambiguator: first non-whitespace char inside is `>`.
			// Double-brace only.
			if !is_raw {
				let mut probe = i;
				while probe < len {
					let pc = chars[probe];
					if pc == ' ' || pc == '\t' || pc == '\n' || pc == '\r' {
						probe += 1;
						continue;
					}
					break;
				}
				if probe < len && chars[probe] == '>' {
					while i < probe {
						advance(&mut cursor, chars[i]);
						i += 1;
					}
					advance(&mut cursor, '>');
					i += 1;

					let mut name_inner = String::new();
					let mut slot_closed = false;
					while i < len {
						let sc = chars[i];
						if sc == '}' && i + 1 < len && chars[i + 1] == '}' {
							if i + 2 < len && chars[i + 2] == '}' {
								return Err(make_err(
									ErrorCode::UnclosedInterpolation,
									format!(
										"Asymmetric slot braces at line {}, column {}",
										open_line, open_column
									),
									open_line,
									open_column,
									options,
								));
							}
							advance(&mut cursor, '}');
							advance(&mut cursor, '}');
							i += 2;
							slot_closed = true;
							break;
						}
						name_inner.push(sc);
						advance(&mut cursor, sc);
						i += 1;
					}

					if !slot_closed {
						return Err(make_err(
							ErrorCode::UnclosedInterpolation,
							format!(
								"Unclosed slot placeholder at line {}, column {}",
								open_line, open_column
							),
							open_line,
							open_column,
							options,
						));
					}

					let slot_name = name_inner.trim().to_string();
					if slot_name.is_empty() {
						return Err(make_err(
							ErrorCode::ParseError,
							format!(
								"Empty slot name at line {}, column {}",
								open_line, open_column
							),
							open_line,
							open_column,
							options,
						));
					}
					if !SLOT_NAME_RE.is_match(&slot_name) {
						return Err(make_err(
							ErrorCode::ParseError,
							format!(
								"Invalid slot name '{}' at line {}, column {}",
								slot_name, open_line, open_column
							),
							open_line,
							open_column,
							options,
						));
					}

					tokens.push(Token::SlotPlaceholder {
						name: slot_name,
						line: open_line,
						column: open_column,
					});

					text_start_line = cursor.line;
					text_start_column = cursor.column;
					continue;
				}
			}

			// Triple-brace + `>` is rejected.
			if is_raw {
				let mut probe = i;
				while probe < len {
					let pc = chars[probe];
					if pc == ' ' || pc == '\t' || pc == '\n' || pc == '\r' {
						probe += 1;
						continue;
					}
					break;
				}
				if probe < len && chars[probe] == '>' {
					return Err(make_err(
						ErrorCode::ParseError,
						format!(
							"Slot placeholder must use double braces; got triple-brace form at line {}, column {}",
							open_line, open_column
						),
						open_line,
						open_column,
						options,
					));
				}
			}

			// Inner-expression scan. String-aware so `}}` / `}}}` inside
			// quoted literals does not terminate the interpolation. The
			// (exprLine, exprColumn) snap to the first non-whitespace char
			// after the opening braces.
			let mut inner = String::new();
			let mut closed = false;
			let mut string_delim: Option<char> = None;
			let mut expr_line = cursor.line;
			let mut expr_column = cursor.column;
			let mut expr_start_found = false;

			while i < len {
				let c = chars[i];
				if string_delim.is_none() {
					if is_raw {
						if c == '}'
							&& i + 1 < len
							&& chars[i + 1] == '}'
							&& i + 2 < len
							&& chars[i + 2] == '}'
						{
							advance(&mut cursor, '}');
							advance(&mut cursor, '}');
							advance(&mut cursor, '}');
							i += 3;
							closed = true;
							break;
						}
						if c == '}' && i + 1 < len && chars[i + 1] == '}' {
							return Err(make_err(
								ErrorCode::UnclosedInterpolation,
								format!(
									"Unclosed triple-brace interpolation at line {}, column {}",
									open_line, open_column
								),
								open_line,
								open_column,
								options,
							));
						}
					} else if c == '}' && i + 1 < len && chars[i + 1] == '}' {
						if i + 2 < len && chars[i + 2] == '}' {
							return Err(make_err(
								ErrorCode::UnclosedInterpolation,
								format!(
									"Asymmetric interpolation braces at line {}, column {}",
									open_line, open_column
								),
								open_line,
								open_column,
								options,
							));
						}
						advance(&mut cursor, '}');
						advance(&mut cursor, '}');
						i += 2;
						closed = true;
						break;
					}
					if c == '"' || c == '\'' {
						string_delim = Some(c);
					}
					if !expr_start_found
						&& c != ' '
						&& c != '\t'
						&& c != '\n'
						&& c != '\r'
					{
						expr_line = cursor.line;
						expr_column = cursor.column;
						expr_start_found = true;
					}
				} else {
					if c == '\\' && i + 1 < len {
						let esc_next = chars[i + 1];
						inner.push(c);
						inner.push(esc_next);
						advance(&mut cursor, c);
						advance(&mut cursor, esc_next);
						i += 2;
						continue;
					}
					if Some(c) == string_delim {
						string_delim = None;
					}
				}
				inner.push(c);
				advance(&mut cursor, c);
				i += 1;
			}

			if !closed {
				return Err(make_err(
					ErrorCode::UnclosedInterpolation,
					format!(
						"Unclosed interpolation at line {}, column {}",
						open_line, open_column
					),
					open_line,
					open_column,
					options,
				));
			}

			// Right-trim `{{ … -}}` / `{{{ … -}}}`: a `-` right before the close
			// braces strips the leading whitespace of the following text run.
			if inner.ends_with('-') {
				inner.pop();
				trim_pending_left = true;
			}
			let expression = inner.trim().to_string();
			if expression.is_empty() {
				return Err(make_err(
					ErrorCode::ParseError,
					format!(
						"Empty interpolation at line {}, column {}",
						open_line, open_column
					),
					open_line,
					open_column,
					options,
				));
			}

			tokens.push(if is_raw {
				Token::InterpRaw {
					expression,
					line: open_line,
					column: open_column,
					expr_line,
					expr_column,
				}
			} else {
				Token::InterpEscaped {
					expression,
					line: open_line,
					column: open_column,
					expr_line,
					expr_column,
				}
			});

			text_start_line = cursor.line;
			text_start_column = cursor.column;
			continue;
		}

		text_buf.push(ch);
		advance(&mut cursor, ch);
		i += 1;
	}

	flush_text!(cursor, text_start_line, text_start_column, text_buf, tokens);
	Ok(tokens)
}

fn make_err(
	code: ErrorCode,
	message: String,
	line: u32,
	column: u32,
	options: &LexOptions,
) -> InkerError {
	let mut err = InkerError::new(code, message).with_pos(line, column);
	if let Some(name) = &options.template_path {
		err = err.with_template(name.clone());
	}
	err
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn empty_source_returns_empty() {
		let toks = lex("", &LexOptions::default()).unwrap();
		assert!(toks.is_empty());
	}

	#[test]
	fn pure_text_passes_through() {
		let toks = lex("hello world", &LexOptions::default()).unwrap();
		assert_eq!(toks.len(), 1);
		match &toks[0] {
			Token::Text { value, line, column } => {
				assert_eq!(value, "hello world");
				assert_eq!(*line, 1);
				assert_eq!(*column, 1);
			}
			_ => panic!("expected Text"),
		}
	}

	#[test]
	fn double_brace_emits_interp_escaped() {
		let toks = lex("{{ name }}", &LexOptions::default()).unwrap();
		assert_eq!(toks.len(), 1);
		match &toks[0] {
			Token::InterpEscaped { expression, .. } => assert_eq!(expression, "name"),
			_ => panic!("expected InterpEscaped"),
		}
	}

	#[test]
	fn triple_brace_emits_interp_raw() {
		let toks = lex("{{{ raw }}}", &LexOptions::default()).unwrap();
		assert_eq!(toks.len(), 1);
		assert!(matches!(toks[0], Token::InterpRaw { .. }));
	}

	#[test]
	fn slot_disambiguator() {
		let toks = lex("{{> body }}", &LexOptions::default()).unwrap();
		assert_eq!(toks.len(), 1);
		match &toks[0] {
			Token::SlotPlaceholder { name, .. } => assert_eq!(name, "body"),
			_ => panic!("expected SlotPlaceholder"),
		}
	}

	#[test]
	fn block_tag_emits_raw_inner() {
		let toks = lex("@layout('main')", &LexOptions::default()).unwrap();
		assert_eq!(toks.len(), 1);
		match &toks[0] {
			Token::BlockTag { raw, .. } => assert_eq!(raw, "layout 'main'"),
			_ => panic!("expected BlockTag"),
		}
	}

	#[test]
	fn at_escapes_produce_literal_output() {
		// `@@` → literal `@`; `@{{` → literal `{{` (suppress interpolation).
		let toks = lex("a@@b @{{ x }}c", &LexOptions::default()).unwrap();
		assert_eq!(toks.len(), 1);
		match &toks[0] {
			Token::Text { value, .. } => assert_eq!(value, "a@b {{ x }}c"),
			_ => panic!("expected Text"),
		}
	}

	#[test]
	fn trim_markers_strip_adjacent_whitespace() {
		// `{{- x -}}` trims trailing ws of the preceding text + leading ws of next.
		let toks = lex("a   {{- x -}}   b", &LexOptions::default()).unwrap();
		assert_eq!(toks.len(), 3);
		match &toks[0] {
			Token::Text { value, .. } => assert_eq!(value, "a"),
			_ => panic!("expected Text 'a'"),
		}
		match &toks[1] {
			Token::InterpEscaped { expression, .. } => assert_eq!(expression, "x"),
			_ => panic!("expected InterpEscaped 'x'"),
		}
		match &toks[2] {
			Token::Text { value, .. } => assert_eq!(value, "b"),
			_ => panic!("expected Text 'b'"),
		}
	}

	#[test]
	fn unclosed_interpolation_errors() {
		let err = lex("{{ foo", &LexOptions::default()).unwrap_err();
		assert_eq!(err.code, ErrorCode::UnclosedInterpolation);
	}

	#[test]
	fn unclosed_block_tag_errors() {
		let err = lex("@if(x", &LexOptions::default()).unwrap_err();
		assert_eq!(err.code, ErrorCode::UnclosedBlockTag);
	}

	#[test]
	fn empty_interp_errors_as_parse_error() {
		let err = lex("{{ }}", &LexOptions::default()).unwrap_err();
		assert_eq!(err.code, ErrorCode::ParseError);
	}

	#[test]
	fn string_close_brace_inside_quotes_does_not_terminate() {
		let toks = lex("{{ \"a}}b\" }}", &LexOptions::default()).unwrap();
		assert_eq!(toks.len(), 1);
		match &toks[0] {
			Token::InterpEscaped { expression, .. } => {
				assert_eq!(expression, "\"a}}b\"");
			}
			_ => panic!("expected InterpEscaped"),
		}
	}

	#[test]
	fn comment_is_stripped_entirely() {
		let toks = lex("a{{-- hidden {{ x }} --}}b", &LexOptions::default()).unwrap();
		assert_eq!(toks.len(), 2);
		match (&toks[0], &toks[1]) {
			(Token::Text { value: a, .. }, Token::Text { value: b, .. }) => {
				assert_eq!(a, "a");
				assert_eq!(b, "b");
			}
			_ => panic!("expected two Text tokens around the stripped comment"),
		}
	}

	#[test]
	fn comment_only_emits_no_tokens() {
		let toks = lex("{{-- just a note --}}", &LexOptions::default()).unwrap();
		assert!(toks.is_empty());
	}

	#[test]
	fn unclosed_comment_errors() {
		let err = lex("{{-- never closed", &LexOptions::default()).unwrap_err();
		assert_eq!(err.code, ErrorCode::UnclosedInterpolation);
	}

	#[test]
	fn text_then_interp_then_text() {
		let toks = lex("hi {{ x }} bye", &LexOptions::default()).unwrap();
		assert_eq!(toks.len(), 3);
		assert!(matches!(toks[0], Token::Text { .. }));
		assert!(matches!(toks[1], Token::InterpEscaped { .. }));
		assert!(matches!(toks[2], Token::Text { .. }));
	}
}
