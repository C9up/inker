//! Block-tag parser — mirrors `packages/inker/src/parseBlockTag.ts` 1:1.
//!
//! Recognises `layout`, `include`, `if`/`else`/`endif`, `each`/`endeach`,
//! `component`. Emits final-shape AST nodes for layout/include/component and
//! "open / close / else" tokens for `if` / `each` so the top-level parser
//! (`parse.rs`) can balance the structure.

use crate::ast::{
	ComponentArg, ComponentNode, EachBinding, IfCondition, LayoutNode, PartialNode,
};
use crate::error::{ErrorCode, InkerError};
use crate::identifiers::{is_prototype_pollution_key, is_reserved_binding};
use crate::parse_expression::{
	parse_expression_with_helper_count, Expression, ParseExpressionOptions,
};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashSet;

const UNKNOWN_DIRECTIVE_HINT: &str = "Inker 53.4 supports `layout`, `include`, `if`/`else`/`endif`, `each`/`endeach`, and `component`.";

static REJECTED_DIRECTIVES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
	let mut s = HashSet::new();
	for n in [
		"for",
		"endfor",
		"endcomponent",
		"unless",
		"endunless",
		"set",
		"let",
		"raw",
		"endraw",
		"block",
		"endblock",
		"section",
		"endsection",
		"extends",
		"import",
		"from",
		"with",
		"as",
	] {
		s.insert(n);
	}
	s
});

static KNOWN_KEYWORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
	let mut s = HashSet::new();
	for n in [
		"layout",
		"include",
		"if",
		"else",
		"endif",
		"each",
		"endeach",
		"component",
	] {
		s.insert(n);
	}
	s
});

static BINDING_RE: Lazy<Regex> = Lazy::new(|| {
	Regex::new(r"^[a-zA-Z_$][a-zA-Z0-9_$]*$").expect("static regex")
});

static IDENT_CONT_RE: Lazy<Regex> =
	Lazy::new(|| Regex::new(r"^[a-zA-Z0-9_$]$").expect("static regex"));

static DRIVE_LETTER_RE: Lazy<Regex> =
	Lazy::new(|| Regex::new(r"^[A-Za-z]:").expect("static regex"));

fn is_whitespace(ch: char) -> bool {
	ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r'
}

fn fail_parse(
	message: impl Into<String>,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> InkerError {
	let mut e = InkerError::new(
		ErrorCode::ParseError,
		format!("{} at line {line}, column {column}", message.into()),
	)
	.with_pos(line, column);
	if let Some(t) = template_path {
		e = e.with_template(t.to_string());
	}
	e
}

fn fail_invalid_expression(
	message: impl Into<String>,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> InkerError {
	let mut e = InkerError::new(
		ErrorCode::InvalidExpression,
		format!("{} at line {line}, column {column}.", message.into()),
	)
	.with_pos(line, column);
	if let Some(t) = template_path {
		e = e.with_template(t.to_string());
	}
	e
}

fn fail_unknown_directive(
	keyword: &str,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> InkerError {
	let mut e = InkerError::new(
		ErrorCode::UnknownDirective,
		format!(
			"Directive '{keyword}' not supported — {UNKNOWN_DIRECTIVE_HINT} (at line {line}, column {column})"
		),
	)
	.with_pos(line, column);
	if let Some(t) = template_path {
		e = e.with_template(t.to_string());
	}
	e
}

fn skip_whitespace(chars: &[char], i: usize) -> usize {
	let mut j = i;
	while j < chars.len() && is_whitespace(chars[j]) {
		j += 1;
	}
	j
}

fn read_keyword(chars: &[char], i: usize) -> (String, usize) {
	let mut j = i;
	while j < chars.len() && !is_whitespace(chars[j]) && chars[j] != '{' {
		j += 1;
	}
	(chars[i..j].iter().collect(), j)
}

fn read_quoted_string(
	chars: &[char],
	i: usize,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<(String, usize), InkerError> {
	let quote = chars.get(i).copied().unwrap_or(' ');
	if quote != '\'' && quote != '"' {
		return Err(fail_parse(
			"directive requires a quoted template name",
			line,
			column,
			template_path,
		));
	}
	let mut j = i + 1;
	let mut out = String::new();
	while j < chars.len() {
		let c = chars[j];
		if c == '\\' {
			if j + 1 >= chars.len() {
				return Err(fail_parse(
					"unterminated escape inside quoted template name",
					line,
					column,
					template_path,
				));
			}
			let next = chars[j + 1];
			if next == '\\' || next == quote {
				out.push(next);
				j += 2;
				continue;
			}
			return Err(fail_parse(
				format!(
					"unsupported escape sequence '\\{next}' inside quoted template name (only \\\\ and \\{quote} allowed)"
				),
				line,
				column,
				template_path,
			));
		}
		if c == quote {
			return Ok((out, j + 1));
		}
		out.push(c);
		j += 1;
	}
	Err(fail_parse(
		"unterminated quoted template name",
		line,
		column,
		template_path,
	))
}

fn validate_path_name(
	name: &str,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<(), InkerError> {
	if name.is_empty() {
		return Err(fail_parse(
			"directive requires a non-empty template name",
			line,
			column,
			template_path,
		));
	}
	if name.contains('\0') {
		return Err(fail_parse(
			"template name contains a NUL byte",
			line,
			column,
			template_path,
		));
	}
	if name.contains('\\') {
		return Err(fail_parse(
			format!("Template name must use forward slashes; got '{name}'"),
			line,
			column,
			template_path,
		));
	}
	if name.starts_with('/') {
		return Err(fail_parse(
			format!(
				"Template name must be relative to the templates root; got absolute path '{name}'"
			),
			line,
			column,
			template_path,
		));
	}
	if DRIVE_LETTER_RE.is_match(name) {
		return Err(fail_parse(
			format!(
				"Template name must be relative to the templates root; got absolute path '{name}'"
			),
			line,
			column,
			template_path,
		));
	}
	if name.starts_with('~') {
		return Err(fail_parse(
			format!(
				"Template name cannot start with '~' (tilde expansion is not supported); got '{name}'"
			),
			line,
			column,
			template_path,
		));
	}
	for segment in name.split('/') {
		if segment == ".." {
			return Err(fail_parse(
				format!("Template name cannot contain '..' segments; got '{name}'"),
				line,
				column,
				template_path,
			));
		}
		if segment.is_empty() {
			return Err(fail_parse(
				format!(
					"Template name cannot contain empty path segments; got '{name}'"
				),
				line,
				column,
				template_path,
			));
		}
		if segment == "." {
			return Err(fail_parse(
				format!("Template name cannot contain '.' segments; got '{name}'"),
				line,
				column,
				template_path,
			));
		}
	}
	Ok(())
}

fn parse_layout_or_include(
	keyword: &str,
	raw: &str,
	chars: &[char],
	line: u32,
	column: u32,
	template_path: Option<&str>,
	after_keyword: usize,
) -> Result<LayoutOrInclude, InkerError> {
	let after_kw_space = skip_whitespace(chars, after_keyword);
	if after_kw_space >= chars.len() {
		return Err(fail_parse(
			format!(
				"{keyword} directive requires a quoted template name; got '{raw}'"
			),
			line,
			column,
			template_path,
		));
	}
	let (name, next) =
		read_quoted_string(chars, after_kw_space, line, column, template_path)?;
	validate_path_name(&name, line, column, template_path)?;

	let after_name = skip_whitespace(chars, next);
	if after_name < chars.len() {
		let trailing: String = chars[next..].iter().collect();
		return Err(fail_parse(
			format!("Unexpected tokens after {keyword} name: '{trailing}'"),
			line,
			column,
			template_path,
		));
	}

	if keyword == "layout" {
		Ok(LayoutOrInclude::Layout(LayoutNode {
			name,
			raw: raw.to_string(),
			line,
			column,
		}))
	} else {
		Ok(LayoutOrInclude::Partial(PartialNode {
			name,
			raw: raw.to_string(),
			line,
			column,
		}))
	}
}

pub enum LayoutOrInclude {
	Layout(LayoutNode),
	Partial(PartialNode),
}

fn parse_if_tag(
	chars: &[char],
	line: u32,
	column: u32,
	template_path: Option<&str>,
	after_keyword: usize,
	helpers: &HashSet<String>,
	helper_id_start: u32,
) -> Result<(IfCondition, u32), InkerError> {
	let i = skip_whitespace(chars, after_keyword);
	if i >= chars.len() {
		return Err(fail_invalid_expression(
			"if directive requires an expression",
			line,
			column,
			template_path,
		));
	}
	let expr_source: String = chars[i..].iter().collect::<String>().trim().to_string();
	if expr_source.is_empty() {
		return Err(fail_invalid_expression(
			"if directive requires an expression",
			line,
			column,
			template_path,
		));
	}
	let options = ParseExpressionOptions {
		template_path: template_path.map(|s| s.to_string()),
		helpers: helpers.clone(),
	};
	let (expression, next_id) = parse_expression_with_helper_count(
		&expr_source,
		line,
		column,
		&options,
		helper_id_start,
	)?;
	Ok((
		IfCondition {
			expression,
			source: expr_source,
		},
		next_id,
	))
}

fn read_binding_name(
	chars: &[char],
	mut i: usize,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<(String, usize), InkerError> {
	i = skip_whitespace(chars, i);
	let start = i;
	while i < chars.len() {
		let c = chars[i];
		if !IDENT_CONT_RE.is_match(&c.to_string()) {
			break;
		}
		i += 1;
	}
	let name: String = chars[start..i].iter().collect();
	if name.is_empty() {
		return Err(fail_invalid_expression(
			"destructured each binding expected identifier",
			line,
			column,
			template_path,
		));
	}
	if !BINDING_RE.is_match(&name) {
		return Err(fail_invalid_expression(
			format!("destructured each binding '{name}' is not a valid identifier"),
			line,
			column,
			template_path,
		));
	}
	if is_reserved_binding(&name) {
		return Err(fail_invalid_expression(
			format!("destructured each binding '{name}' is a reserved word"),
			line,
			column,
			template_path,
		));
	}
	if is_prototype_pollution_key(&name) {
		return Err(fail_invalid_expression(
			format!(
				"destructured each binding '{name}' is forbidden (prototype-pollution surface)"
			),
			line,
			column,
			template_path,
		));
	}
	Ok((name, i))
}

fn parse_destructured_binding(
	chars: &[char],
	start_in_binding: usize,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<EachBinding, InkerError> {
	let mut i = start_in_binding;
	if chars.get(i).copied() != Some('[') {
		return Err(fail_invalid_expression(
			"destructured each binding must start with '['",
			line,
			column,
			template_path,
		));
	}
	i += 1;
	let (first, next_i) = read_binding_name(chars, i, line, column, template_path)?;
	i = skip_whitespace(chars, next_i);
	if chars.get(i).copied() != Some(',') {
		return Err(fail_invalid_expression(
			"destructured each binding must have exactly two names: '[k, v]'",
			line,
			column,
			template_path,
		));
	}
	i += 1;
	let (second, next_i) = read_binding_name(chars, i, line, column, template_path)?;
	i = skip_whitespace(chars, next_i);
	if chars.get(i).copied() != Some(']') {
		let peek = chars.get(i).copied();
		if peek == Some(',') {
			return Err(fail_invalid_expression(
				"destructured each binding has too many names — exactly two allowed",
				line,
				column,
				template_path,
			));
		}
		return Err(fail_invalid_expression(
			"destructured each binding expected ']' to close the pair",
			line,
			column,
			template_path,
		));
	}
	i += 1;
	let trailing: String = chars[i..].iter().collect::<String>().trim().to_string();
	if !trailing.is_empty() {
		return Err(fail_invalid_expression(
			format!("unexpected tokens after destructured binding: '{trailing}'"),
			line,
			column,
			template_path,
		));
	}
	if first == second {
		return Err(fail_invalid_expression(
			format!("destructured each binding has duplicate name '{first}'"),
			line,
			column,
			template_path,
		));
	}
	Ok(EachBinding::Destructured([first, second]))
}

/// Locate the top-level ` as ` separator inside an each directive body.
/// Honors string literals + bracket/brace/paren nesting.
/// Returns (start, end) of the whitespace-as-whitespace span in `s`, or None.
fn find_top_level_as(s: &[char]) -> Option<(usize, usize)> {
	let mut depth: i32 = 0;
	let mut string_delim: Option<char> = None;
	let mut i = 0;
	while i < s.len() {
		let c = s[i];
		if let Some(delim) = string_delim {
			if c == '\\' && i + 1 < s.len() {
				i += 2;
				continue;
			}
			if c == delim {
				string_delim = None;
			}
			i += 1;
			continue;
		}
		if c == '"' || c == '\'' {
			string_delim = Some(c);
			i += 1;
			continue;
		}
		if c == '[' || c == '(' || c == '{' {
			depth += 1;
			i += 1;
			continue;
		}
		if c == ']' || c == ')' || c == '}' {
			depth -= 1;
			i += 1;
			continue;
		}
		if depth == 0 && is_whitespace(c) {
			let ws_start = i;
			while i < s.len() && is_whitespace(s[i]) {
				i += 1;
			}
			if i + 2 < s.len()
				&& s[i] == 'a'
				&& s[i + 1] == 's'
				&& is_whitespace(s[i + 2])
			{
				let mut j = i + 2;
				while j < s.len() && is_whitespace(s[j]) {
					j += 1;
				}
				return Some((ws_start, j));
			}
			continue;
		}
		i += 1;
	}
	None
}

fn parse_each_tag(
	chars: &[char],
	line: u32,
	column: u32,
	template_path: Option<&str>,
	after_keyword: usize,
	helpers: &HashSet<String>,
	helper_id_start: u32,
) -> Result<(Expression, String, EachBinding, u32), InkerError> {
	let start = skip_whitespace(chars, after_keyword);
	if start >= chars.len() {
		return Err(fail_invalid_expression(
			"each directive requires '<iterable> as <binding>'",
			line,
			column,
			template_path,
		));
	}

	let body = &chars[start..];
	let as_match = match find_top_level_as(body) {
		Some(m) => m,
		None => {
			return Err(fail_invalid_expression(
				"each directive requires '<iterable> as <binding>' — missing 'as' keyword",
				line,
				column,
				template_path,
			));
		}
	};

	let iterable_source: String =
		body[..as_match.0].iter().collect::<String>().trim().to_string();
	if iterable_source.is_empty() {
		return Err(fail_invalid_expression(
			"each directive requires an iterable expression before 'as'",
			line,
			column,
			template_path,
		));
	}
	let options = ParseExpressionOptions {
		template_path: template_path.map(|s| s.to_string()),
		helpers: helpers.clone(),
	};
	let (iterable, next_id) = parse_expression_with_helper_count(
		&iterable_source,
		line,
		column,
		&options,
		helper_id_start,
	)?;

	let after_as = start + as_match.1;
	let binding_tail_raw: String = chars[after_as..].iter().collect();
	let binding_tail = binding_tail_raw.trim().to_string();
	if binding_tail.is_empty() {
		return Err(fail_invalid_expression(
			"each directive requires a binding identifier after 'as'",
			line,
			column,
			template_path,
		));
	}

	if binding_tail.starts_with('[') {
		// Find the absolute char position of `[` in chars.
		let bracket_at = after_as
			+ binding_tail_raw
				.char_indices()
				.find(|(_, c)| *c == '[')
				.map(|(b, _)| {
					// b is byte position in binding_tail_raw; we need char position.
					// chars in binding_tail_raw are 1:1 mapped to slice of chars.
					binding_tail_raw[..b].chars().count()
				})
				.expect("starts_with '[' ensures one exists");
		let binding =
			parse_destructured_binding(chars, bracket_at, line, column, template_path)?;
		return Ok((iterable, iterable_source, binding, next_id));
	}

	if !BINDING_RE.is_match(&binding_tail) {
		return Err(fail_invalid_expression(
			format!(
				"each binding '{binding_tail}' is not a valid identifier (must match /^[a-zA-Z_$][a-zA-Z0-9_$]*$/)"
			),
			line,
			column,
			template_path,
		));
	}
	if is_reserved_binding(&binding_tail) {
		return Err(fail_invalid_expression(
			format!("each binding '{binding_tail}' is a reserved word"),
			line,
			column,
			template_path,
		));
	}
	if is_prototype_pollution_key(&binding_tail) {
		return Err(fail_invalid_expression(
			format!(
				"each binding '{binding_tail}' is forbidden (prototype-pollution surface)"
			),
			line,
			column,
			template_path,
		));
	}

	Ok((
		iterable,
		iterable_source,
		EachBinding::Single(binding_tail),
		next_id,
	))
}

/// Slice an object literal (`{ … }`) accounting for nested braces/brackets/
/// parens and string literals. Returns the substring including both `{`
/// and `}` (as a String for ownership) and the END index in `chars`.
fn slice_balanced_object(
	chars: &[char],
	start: usize,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<(String, usize), InkerError> {
	if chars.get(start).copied() != Some('{') {
		return Err(fail_invalid_expression(
			"expected '{' to start object literal",
			line,
			column,
			template_path,
		));
	}
	let mut opener_stack: Vec<char> = Vec::new();
	let mut string_char: Option<char> = None;
	let mut i = start;
	while i < chars.len() {
		let ch = chars[i];
		if let Some(s) = string_char {
			if ch == '\\' && i + 1 < chars.len() {
				i += 2;
				continue;
			}
			if ch == s {
				string_char = None;
			}
			i += 1;
			continue;
		}
		if ch == '\'' || ch == '"' {
			string_char = Some(ch);
			i += 1;
			continue;
		}
		if ch == '{' || ch == '[' || ch == '(' {
			opener_stack.push(ch);
		} else if ch == '}' || ch == ']' || ch == ')' {
			let expected_opener = match ch {
				'}' => '{',
				']' => '[',
				')' => '(',
				_ => unreachable!(),
			};
			let top = opener_stack.last().copied();
			if top != Some(expected_opener) {
				let top_s = top.map(|c| c.to_string()).unwrap_or_else(|| "<empty>".into());
				return Err(fail_invalid_expression(
					format!(
						"mismatched bracket in component args literal: '{ch}' has no matching opener (expected to close '{top_s}')"
					),
					line,
					column,
					template_path,
				));
			}
			opener_stack.pop();
			if opener_stack.is_empty() {
				let slice: String = chars[start..=i].iter().collect();
				return Ok((slice, i + 1));
			}
		}
		i += 1;
	}
	Err(fail_invalid_expression(
		"component args literal is unterminated; expected '}'",
		line,
		column,
		template_path,
	))
}

// Threads the parser-wide position triple (line, column, template_path) plus the
// helper-resolution context, matching the convention already allowed in render.rs.
#[allow(clippy::too_many_arguments)]
fn parse_component_tag(
	raw: &str,
	chars: &[char],
	line: u32,
	column: u32,
	template_path: Option<&str>,
	after_keyword: usize,
	helpers: &HashSet<String>,
	helper_id_start: u32,
) -> Result<(ComponentNode, u32), InkerError> {
	let after_kw_space = skip_whitespace(chars, after_keyword);
	if after_kw_space >= chars.len() {
		return Err(fail_invalid_expression(
			"component directive requires a quoted component name",
			line,
			column,
			template_path,
		));
	}
	let (name, next) =
		read_quoted_string(chars, after_kw_space, line, column, template_path)?;
	validate_path_name(&name, line, column, template_path)?;

	let mut i = skip_whitespace(chars, next);
	let mut args: Vec<ComponentArg> = Vec::new();
	let mut next_id = helper_id_start;

	if i < chars.len() {
		if chars.get(i).copied() != Some('{') {
			return Err(fail_invalid_expression(
				format!(
					"component directive expected '{{' after name, got '{}'",
					chars[i]
				),
				line,
				column,
				template_path,
			));
		}
		let obj_start = i;
		let (obj_source, obj_end) =
			slice_balanced_object(chars, obj_start, line, column, template_path)?;
		// Compute the line/column at obj_start within the raw block (char-based)
		let mut obj_line = line;
		let mut obj_column = column;
		for &ch in &chars[..obj_start] {
			if ch == '\n' {
				obj_line += 1;
				obj_column = 1;
			} else if ch != '\r' {
				// `\r` is invisible to column counting, matching the lexer's
				// `advance` and `parse_expression::position_at`.
				obj_column += 1;
			}
		}
		let opts = ParseExpressionOptions {
			template_path: template_path.map(|s| s.to_string()),
			helpers: helpers.clone(),
		};
		let (obj_expr, end_id) = parse_expression_with_helper_count(
			&obj_source,
			obj_line,
			obj_column,
			&opts,
			next_id,
		)?;
		next_id = end_id;
		let entries = match obj_expr {
			Expression::Object { entries, .. } => entries,
			_ => {
				return Err(fail_invalid_expression(
					"component directive expected an object literal for args",
					line,
					column,
					template_path,
				));
			}
		};
		let mut seen: HashSet<String> = HashSet::new();
		for entry in entries {
			if seen.contains(&entry.key) {
				return Err(fail_invalid_expression(
					format!("component arg key '{}' is duplicated", entry.key),
					line,
					column,
					template_path,
				));
			}
			seen.insert(entry.key.clone());
			let value_source = entry.value.source().to_string();
			args.push(ComponentArg {
				key: entry.key,
				value: entry.value,
				source: value_source,
			});
		}
		i = obj_end;
	}

	let trailing: String = chars[i..].iter().collect::<String>().trim().to_string();
	if !trailing.is_empty() {
		return Err(fail_invalid_expression(
			format!("Unexpected tokens after component args: '{trailing}'"),
			line,
			column,
			template_path,
		));
	}

	Ok((
		ComponentNode {
			name,
			args,
			raw: raw.to_string(),
			line,
			column,
		},
		next_id,
	))
}

#[derive(Debug, Clone, PartialEq)]
pub enum BlockClosesKind {
	If,
	Each,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParsedBlockTag {
	Layout(LayoutNode),
	Partial(PartialNode),
	Component(ComponentNode),
	OpenIf {
		condition: IfCondition,
		line: u32,
		column: u32,
	},
	OpenEach {
		iterable: Expression,
		iterable_source: String,
		binding: EachBinding,
		line: u32,
		column: u32,
	},
	Close {
		closes: BlockClosesKind,
		line: u32,
		column: u32,
	},
	Else {
		line: u32,
		column: u32,
	},
}

#[derive(Debug, Default, Clone)]
pub struct ParseBlockTagOptions {
	pub template_path: Option<String>,
	pub helpers: HashSet<String>,
}

/// Returns the parsed block tag AND the updated helper-id counter (the parser
/// consumes ids monotonically across the entire template).
pub fn parse_block_tag(
	raw: &str,
	line: u32,
	column: u32,
	options: &ParseBlockTagOptions,
	helper_id_start: u32,
) -> Result<(ParsedBlockTag, u32), InkerError> {
	let template_path = options.template_path.as_deref();
	let helpers = &options.helpers;
	let chars: Vec<char> = raw.chars().collect();

	let start_of_keyword = skip_whitespace(&chars, 0);
	let (keyword, after_keyword) = read_keyword(&chars, start_of_keyword);

	if keyword.is_empty() {
		return Err(fail_parse(
			"Empty block tag directive",
			line,
			column,
			template_path,
		));
	}

	if REJECTED_DIRECTIVES.contains(keyword.as_str()) {
		return Err(fail_unknown_directive(&keyword, line, column, template_path));
	}
	if !KNOWN_KEYWORDS.contains(keyword.as_str()) {
		return Err(fail_unknown_directive(&keyword, line, column, template_path));
	}

	if keyword == "layout" || keyword == "include" {
		let result = parse_layout_or_include(
			&keyword,
			raw,
			&chars,
			line,
			column,
			template_path,
			after_keyword,
		)?;
		let pb = match result {
			LayoutOrInclude::Layout(n) => ParsedBlockTag::Layout(n),
			LayoutOrInclude::Partial(n) => ParsedBlockTag::Partial(n),
		};
		return Ok((pb, helper_id_start));
	}

	if keyword == "if" {
		let (condition, next_id) = parse_if_tag(
			&chars,
			line,
			column,
			template_path,
			after_keyword,
			helpers,
			helper_id_start,
		)?;
		return Ok((
			ParsedBlockTag::OpenIf {
				condition,
				line,
				column,
			},
			next_id,
		));
	}

	if keyword == "each" {
		let (iterable, iterable_source, binding, next_id) = parse_each_tag(
			&chars,
			line,
			column,
			template_path,
			after_keyword,
			helpers,
			helper_id_start,
		)?;
		return Ok((
			ParsedBlockTag::OpenEach {
				iterable,
				iterable_source,
				binding,
				line,
				column,
			},
			next_id,
		));
	}

	if keyword == "endif" {
		let trailing: String = chars[after_keyword..].iter().collect::<String>().trim().to_string();
		if !trailing.is_empty() {
			return Err(fail_parse(
				format!("Unexpected tokens after endif: '{trailing}'"),
				line,
				column,
				template_path,
			));
		}
		return Ok((
			ParsedBlockTag::Close {
				closes: BlockClosesKind::If,
				line,
				column,
			},
			helper_id_start,
		));
	}

	if keyword == "endeach" {
		let trailing: String = chars[after_keyword..].iter().collect::<String>().trim().to_string();
		if !trailing.is_empty() {
			return Err(fail_parse(
				format!("Unexpected tokens after endeach: '{trailing}'"),
				line,
				column,
				template_path,
			));
		}
		return Ok((
			ParsedBlockTag::Close {
				closes: BlockClosesKind::Each,
				line,
				column,
			},
			helper_id_start,
		));
	}

	if keyword == "else" {
		let trailing: String = chars[after_keyword..].iter().collect::<String>().trim().to_string();
		if !trailing.is_empty() {
			return Err(fail_invalid_expression(
				format!(
					"Unexpected tokens after else: '{trailing}' — '{{% else if %}}' chains are not supported, use nested {{% if %}}/{{% else %}}/{{% endif %}}"
				),
				line,
				column,
				template_path,
			));
		}
		return Ok((ParsedBlockTag::Else { line, column }, helper_id_start));
	}

	if keyword == "component" {
		let (node, next_id) = parse_component_tag(
			raw,
			&chars,
			line,
			column,
			template_path,
			after_keyword,
			helpers,
			helper_id_start,
		)?;
		return Ok((ParsedBlockTag::Component(node), next_id));
	}

	Err(fail_unknown_directive(&keyword, line, column, template_path))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn opts() -> ParseBlockTagOptions {
		ParseBlockTagOptions::default()
	}

	#[test]
	fn layout_directive() {
		let (pb, _) = parse_block_tag("layout 'main'", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::Layout(n) => assert_eq!(n.name, "main"),
			_ => panic!("expected Layout"),
		}
	}

	#[test]
	fn include_directive() {
		let (pb, _) = parse_block_tag("include 'partials/header'", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::Partial(n) => assert_eq!(n.name, "partials/header"),
			_ => panic!("expected Partial"),
		}
	}

	#[test]
	fn if_open() {
		let (pb, _) = parse_block_tag("if active", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::OpenIf { condition, .. } => {
				assert_eq!(condition.source, "active");
			}
			_ => panic!("expected OpenIf"),
		}
	}

	#[test]
	fn endif() {
		let (pb, _) = parse_block_tag("endif", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::Close { closes: BlockClosesKind::If, .. } => {}
			_ => panic!("expected endif"),
		}
	}

	#[test]
	fn each_single_binding() {
		let (pb, _) = parse_block_tag("each items as item", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::OpenEach { binding, iterable_source, .. } => {
				assert_eq!(binding, EachBinding::Single("item".into()));
				assert_eq!(iterable_source, "items");
			}
			_ => panic!("expected OpenEach"),
		}
	}

	#[test]
	fn each_destructured_binding() {
		let (pb, _) = parse_block_tag("each map as [k, v]", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::OpenEach { binding, .. } => {
				assert_eq!(binding, EachBinding::Destructured(["k".into(), "v".into()]));
			}
			_ => panic!("expected OpenEach"),
		}
	}

	#[test]
	fn endeach() {
		let (pb, _) = parse_block_tag("endeach", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::Close { closes: BlockClosesKind::Each, .. } => {}
			_ => panic!("expected endeach"),
		}
	}

	#[test]
	fn else_tag() {
		let (pb, _) = parse_block_tag("else", 1, 1, &opts(), 0).unwrap();
		assert!(matches!(pb, ParsedBlockTag::Else { .. }));
	}

	#[test]
	fn unknown_directive_rejected() {
		let e = parse_block_tag("for x in y", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::UnknownDirective);
	}

	#[test]
	fn rejected_directive_lists_hint() {
		let e = parse_block_tag("section 'foo'", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::UnknownDirective);
	}

	#[test]
	fn each_single_binding_proto_pollution_rejected() {
		let e = parse_block_tag("each items as __proto__", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}

	#[test]
	fn each_destructured_binding_proto_pollution_rejected() {
		let e = parse_block_tag("each items as [__proto__, v]", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}

	#[test]
	fn path_traversal_rejected() {
		let e = parse_block_tag("layout '../etc/passwd'", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn absolute_path_rejected() {
		let e = parse_block_tag("layout '/etc/passwd'", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn windows_drive_letter_rejected() {
		let e = parse_block_tag("layout 'C:foo'", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn component_with_object_args() {
		let mut o = opts();
		// active is not a helper — it's a path.
		let (pb, _) = parse_block_tag(
			"component 'button' { label: title, disabled: active }",
			1,
			1,
			&o,
			0,
		)
		.unwrap();
		o.helpers.clear();
		match pb {
			ParsedBlockTag::Component(c) => {
				assert_eq!(c.name, "button");
				assert_eq!(c.args.len(), 2);
				assert_eq!(c.args[0].key, "label");
				assert_eq!(c.args[1].key, "disabled");
			}
			_ => panic!("expected Component"),
		}
	}

	#[test]
	fn each_with_helper_call_in_iterable() {
		let mut o = opts();
		o.helpers.insert("sorted".into());
		let (pb, next_id) =
			parse_block_tag("each sorted(items) as item", 1, 1, &o, 5).unwrap();
		match pb {
			ParsedBlockTag::OpenEach { .. } => {}
			_ => panic!("expected OpenEach"),
		}
		assert_eq!(next_id, 6, "helper id assigned starting from 5, advanced to 6");
	}

	#[test]
	fn destructured_binding_duplicate_rejected() {
		let e =
			parse_block_tag("each map as [k, k]", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}
}
