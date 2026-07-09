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

const UNKNOWN_DIRECTIVE_HINT: &str = "Inker supports `@layout`, `@include`/`@includeIf`, `@if`/`@elseif`/`@else`/`@endif`, `@unless`, `@each`/`@endeach`, `@let`, and `@component`/`@slot`.";

static REJECTED_DIRECTIVES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
	let mut s = HashSet::new();
	for n in [
		"for",
		"endfor",
		"set",
		"raw",
		"endraw",
		"block",
		"endblock",
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
		"includeIf",
		"if",
		"elseif",
		"else",
		"endif",
		"each",
		"endeach",
		"let",
		"component",
		"endcomponent",
		"slot",
		"endslot",
		"unless",
		"endunless",
		"section",
		"endsection",
		"super",
		"eval",
		"dump",
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

static SLOT_NAME_RE: Lazy<Regex> = Lazy::new(|| {
	Regex::new(r"^[a-zA-Z_][a-zA-Z0-9_-]*$").expect("static regex compiles")
});

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

/// Locate the top-level ` in ` separator inside an Edge each directive body
/// (`<binding> in <iterable>`). Honors string literals + bracket/brace/paren
/// nesting so `(a, b) in xs` and `x in obj.items` split correctly. Returns the
/// (start, end) of the `in`-with-surrounding-whitespace span, or None.
fn find_top_level_in(s: &[char]) -> Option<(usize, usize)> {
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
			// `in` is bounded by whitespace on the left (the ws run that got us
			// here) and by whitespace OR a delimiter (`(`/`[`) on the right, so
			// `x in(items)` / `x in [a]` split correctly (JS keyword-then-paren).
			if i + 2 < s.len()
				&& s[i] == 'i'
				&& s[i + 1] == 'n'
				&& (is_whitespace(s[i + 2]) || s[i + 2] == '(' || s[i + 2] == '[')
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

/// Validate a single each-binding identifier (reused for `Single`, and each name
/// inside an `(item, index)` indexed binding).
fn validate_each_ident(
	name: &str,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<(), InkerError> {
	if !BINDING_RE.is_match(name) {
		return Err(fail_invalid_expression(
			format!(
				"each binding '{name}' is not a valid identifier (must match /^[a-zA-Z_$][a-zA-Z0-9_$]*$/)"
			),
			line,
			column,
			template_path,
		));
	}
	if is_reserved_binding(name) {
		return Err(fail_invalid_expression(
			format!("each binding '{name}' is a reserved word"),
			line,
			column,
			template_path,
		));
	}
	if is_prototype_pollution_key(name) {
		return Err(fail_invalid_expression(
			format!("each binding '{name}' is forbidden (prototype-pollution surface)"),
			line,
			column,
			template_path,
		));
	}
	Ok(())
}

/// Parse an Edge indexed binding `(item, index)` → `EachBinding::Indexed`.
fn parse_indexed_binding(
	inner: &str,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<EachBinding, InkerError> {
	// `inner` is the text between the parens, e.g. `item, index`.
	let parts: Vec<&str> = inner.split(',').map(|p| p.trim()).collect();
	if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
		return Err(fail_invalid_expression(
			"indexed each binding requires exactly two names: '(value, index)'",
			line,
			column,
			template_path,
		));
	}
	validate_each_ident(parts[0], line, column, template_path)?;
	validate_each_ident(parts[1], line, column, template_path)?;
	if parts[0] == parts[1] {
		return Err(fail_invalid_expression(
			format!("indexed each binding has duplicate name '{}'", parts[0]),
			line,
			column,
			template_path,
		));
	}
	Ok(EachBinding::Indexed {
		item: parts[0].to_string(),
		index: parts[1].to_string(),
	})
}

/// Parsed `@let` payload: `(name-or-verbatim-pattern, RHS expression, verbatim
/// RHS source, is_destructure, bound names, next helper id)`. `names` is empty
/// for a simple `@let(x = …)` and carries the extracted+validated identifiers
/// for a destructuring `@let({ a, b } = …)`.
type ParsedLet = (String, Expression, String, bool, Vec<String>, u32);

#[allow(clippy::too_many_arguments)]
fn parse_let_tag(
	chars: &[char],
	line: u32,
	column: u32,
	template_path: Option<&str>,
	after_keyword: usize,
	helpers: &HashSet<String>,
	helper_id_start: u32,
) -> Result<ParsedLet, InkerError> {
	let pattern_start = skip_whitespace(chars, after_keyword);
	// Destructuring binding — `@let({ a, b } = obj)` / `@let([x, ...rest] = pair)`
	// (Edge parity, 62-2). The pattern is the leading balanced `{…}`/`[…]` group;
	// Rust only balances brackets, the Node renderer owns the JS destructuring.
	if matches!(chars.get(pattern_start).copied(), Some('{') | Some('[')) {
		return parse_let_destructure(
			chars,
			line,
			column,
			template_path,
			pattern_start,
			helpers,
			helper_id_start,
		);
	}
	let mut i = pattern_start;
	let start = i;
	while i < chars.len() && IDENT_CONT_RE.is_match(&chars[i].to_string()) {
		i += 1;
	}
	let name: String = chars[start..i].iter().collect();
	if name.is_empty() {
		return Err(fail_invalid_expression(
			"let directive requires a variable name",
			line,
			column,
			template_path,
		));
	}
	if !BINDING_RE.is_match(&name) {
		return Err(fail_invalid_expression(
			format!("let variable '{name}' is not a valid identifier (must match /^[a-zA-Z_$][a-zA-Z0-9_$]*$/)"),
			line,
			column,
			template_path,
		));
	}
	if is_reserved_binding(&name) {
		return Err(fail_invalid_expression(
			format!("let variable '{name}' is a reserved word"),
			line,
			column,
			template_path,
		));
	}
	if is_prototype_pollution_key(&name) {
		return Err(fail_invalid_expression(
			format!("let variable '{name}' is forbidden (prototype-pollution surface)"),
			line,
			column,
			template_path,
		));
	}
	i = skip_whitespace(chars, i);
	if chars.get(i).copied() != Some('=') {
		return Err(fail_parse(
			format!("let directive requires '=' after the variable name '{name}'"),
			line,
			column,
			template_path,
		));
	}
	if chars.get(i + 1).copied() == Some('=') {
		return Err(fail_parse(
			"let directive uses a single '=' for assignment, not '=='",
			line,
			column,
			template_path,
		));
	}
	i += 1;
	let expr_source: String = chars[i..].iter().collect::<String>().trim().to_string();
	if expr_source.is_empty() {
		return Err(fail_invalid_expression(
			format!("let directive requires an expression after '=' for '{name}'"),
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
	Ok((name, expression, expr_source, false, Vec::new(), next_id))
}

/// Parse a destructuring `@let` — `@let({ a, b } = obj)` / `@let([x, ...rest] =
/// pair)` (Edge parity, 62-2). The leading balanced `{…}`/`[…]` group is the
/// binding pattern (captured verbatim as the returned `name`); the rest after
/// the top-level `=` is the right-hand expression (parsed for helper/proto
/// guards + verbatim source). Like Edge (which compiles the pattern with a real
/// JS parser at compile time), Rust extracts + validates the bound identifiers
/// HERE, at parse: a JS-aware scanner (strings, template literals, regex,
/// comments) walks the pattern so a `,`/`=` inside a default value never mis-
/// splits it, and each bound name goes through the same identifier / reserved-
/// word / prototype-pollution guards as the simple-`@let` and `@each` paths.
/// The Node renderer only evaluates the (already-validated) pattern in V8.
fn parse_let_destructure(
	chars: &[char],
	line: u32,
	column: u32,
	template_path: Option<&str>,
	pattern_start: usize,
	helpers: &HashSet<String>,
	helper_id_start: u32,
) -> Result<ParsedLet, InkerError> {
	let (pattern_raw, after) =
		slice_balanced_pattern(chars, pattern_start, line, column, template_path)?;
	let pattern = pattern_raw.trim().to_string();
	let pattern_chars: Vec<char> = pattern.chars().collect();
	let names = collect_let_names(&pattern_chars, line, column, template_path)?;
	let mut i = skip_whitespace(chars, after);
	if chars.get(i).copied() != Some('=') {
		return Err(fail_parse(
			format!("let destructuring '{pattern}' requires '=' after the pattern"),
			line,
			column,
			template_path,
		));
	}
	if chars.get(i + 1).copied() == Some('=') {
		return Err(fail_parse(
			"let directive uses a single '=' for assignment, not '=='",
			line,
			column,
			template_path,
		));
	}
	i += 1;
	let expr_source: String = chars[i..].iter().collect::<String>().trim().to_string();
	if expr_source.is_empty() {
		return Err(fail_invalid_expression(
			format!("let destructuring '{pattern}' requires an expression after '='"),
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
	Ok((pattern, expression, expr_source, true, names, next_id))
}

/// Slice the leading balanced `{…}` or `[…]` group starting at `start`. JS-aware
/// (see [`skip_js_token`]): brackets inside string / template / regex / comment
/// spans do not count, so a `}` inside `@let({ a = /}/.test(s) } = obj)` cannot
/// prematurely close the pattern. Returns the verbatim group (incl. delimiters)
/// and the index just past its closing bracket.
fn slice_balanced_pattern(
	chars: &[char],
	start: usize,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<(String, usize), InkerError> {
	let close = match chars.get(start).copied() {
		Some('{') => '}',
		Some('[') => ']',
		_ => {
			return Err(fail_invalid_expression(
				"expected '{' or '[' to start a destructuring pattern",
				line,
				column,
				template_path,
			));
		}
	};
	let mut opener_stack: Vec<char> = Vec::new();
	let mut prev_sig = '\0';
	let mut i = start;
	while i < chars.len() {
		if let Some(next) = skip_js_token(chars, i, prev_sig) {
			prev_sig = token_prev_sig(chars, i, prev_sig);
			i = next;
			continue;
		}
		let ch = chars[i];
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
						"mismatched bracket in let destructuring pattern: '{ch}' has no matching opener (expected to close '{top_s}')"
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
		if !ch.is_whitespace() {
			prev_sig = ch;
		}
		i += 1;
	}
	Err(fail_invalid_expression(
		format!("let destructuring pattern is unterminated; expected '{close}'"),
		line,
		column,
		template_path,
	))
}

// ---- JS-aware pattern scanner (62-2 review) ------------------------------
//
// A destructuring `@let` pattern is real JS: `{ a, b: c, d = expr, ...rest }`.
// Extracting the bound names means splitting on TOP-LEVEL commas and finding
// each entry's default `=` — but a default value is an arbitrary JS expression
// that may contain commas / `=` / brackets inside strings, template literals
// (incl. `${…}`), regex literals, or comments. These skip helpers walk over
// such spans exactly as a JS lexer would, so those inner chars never read as
// structural. This is the Rust equivalent of Edge parsing the pattern with a
// real JS parser at compile time.

/// After skipping the token that starts at `i`, the "significant char" to carry
/// forward for regex-vs-division disambiguation: a comment leaves it unchanged;
/// a string / template / regex is a value, so it terminates a regex context.
fn token_prev_sig(chars: &[char], i: usize, prev: char) -> char {
	let is_comment =
		chars[i] == '/' && matches!(chars.get(i + 1).copied(), Some('/') | Some('*'));
	if is_comment { prev } else { 'x' }
}

/// If `chars[i]` begins a string / template literal / regex literal / comment,
/// return the index just past that token; otherwise `None`. `prev_sig` is the
/// last significant char before `i`, used to tell a regex literal (`= /re/`)
/// from a division operator (`a / b`).
fn skip_js_token(chars: &[char], i: usize, prev_sig: char) -> Option<usize> {
	match chars[i] {
		'\'' | '"' => Some(skip_string(chars, i)),
		'`' => Some(skip_template(chars, i)),
		'/' => match chars.get(i + 1).copied() {
			Some('/') => Some(skip_line_comment(chars, i)),
			Some('*') => Some(skip_block_comment(chars, i)),
			_ if regex_allowed(prev_sig) => Some(skip_regex(chars, i)),
			_ => None, // division
		},
		_ => None,
	}
}

/// A `/` starts a regex literal (rather than division) when the previous
/// significant char is not a value terminator (identifier char, `)`, `]`, `}`,
/// `.`, or a just-closed literal — marked `'x'`).
fn regex_allowed(prev: char) -> bool {
	!(prev.is_alphanumeric()
		|| prev == '_'
		|| prev == '$'
		|| prev == ')'
		|| prev == ']'
		|| prev == '}'
		|| prev == '.')
}

/// Skip a `'`/`"` string starting at `i`; returns the index past the close.
fn skip_string(chars: &[char], i: usize) -> usize {
	let quote = chars[i];
	let mut j = i + 1;
	while j < chars.len() {
		match chars[j] {
			'\\' => j += 2,
			c if c == quote => return j + 1,
			_ => j += 1,
		}
	}
	j
}

/// Skip a `` ` `` template literal starting at `i`, balancing nested `${…}`
/// interpolations (which may themselves contain strings/templates/brackets).
fn skip_template(chars: &[char], i: usize) -> usize {
	let mut j = i + 1;
	while j < chars.len() {
		match chars[j] {
			'\\' => j += 2,
			'`' => return j + 1,
			'$' if chars.get(j + 1).copied() == Some('{') => j = skip_braces(chars, j + 1),
			_ => j += 1,
		}
	}
	j
}

/// Skip a balanced `{…}` group starting at `i` (JS-aware for inner tokens).
fn skip_braces(chars: &[char], i: usize) -> usize {
	let mut depth = 0i32;
	let mut prev_sig = '\0';
	let mut j = i;
	while j < chars.len() {
		if let Some(next) = skip_js_token(chars, j, prev_sig) {
			prev_sig = token_prev_sig(chars, j, prev_sig);
			j = next;
			continue;
		}
		let c = chars[j];
		match c {
			'{' => depth += 1,
			'}' => {
				depth -= 1;
				if depth == 0 {
					return j + 1;
				}
			}
			_ => {}
		}
		if !c.is_whitespace() {
			prev_sig = c;
		}
		j += 1;
	}
	j
}

/// Skip a `//` line comment; returns the index of the terminating newline (or
/// end of input).
fn skip_line_comment(chars: &[char], i: usize) -> usize {
	let mut j = i + 2;
	while j < chars.len() && chars[j] != '\n' {
		j += 1;
	}
	j
}

/// Skip a `/* … */` block comment; returns the index past `*/`.
fn skip_block_comment(chars: &[char], i: usize) -> usize {
	let mut j = i + 2;
	while j + 1 < chars.len() {
		if chars[j] == '*' && chars[j + 1] == '/' {
			return j + 2;
		}
		j += 1;
	}
	chars.len()
}

/// Skip a `/…/flags` regex literal starting at `i`, honouring `\` escapes and
/// `[…]` character classes (a `/` inside a class is literal).
fn skip_regex(chars: &[char], i: usize) -> usize {
	let mut j = i + 1;
	let mut in_class = false;
	while j < chars.len() {
		match chars[j] {
			'\\' => {
				j += 2;
				continue;
			}
			'[' => in_class = true,
			']' => in_class = false,
			'/' if !in_class => {
				j += 1;
				while j < chars.len() && chars[j].is_alphabetic() {
					j += 1;
				}
				return j;
			}
			'\n' => return j, // unterminated
			_ => {}
		}
		j += 1;
	}
	j
}

/// Trim leading/trailing ASCII/Unicode whitespace from a `[a, b)` char range.
fn trim_range(chars: &[char], mut a: usize, mut b: usize) -> (usize, usize) {
	while a < b && chars[a].is_whitespace() {
		a += 1;
	}
	while b > a && chars[b - 1].is_whitespace() {
		b -= 1;
	}
	(a, b)
}

/// Return the first top-level index in `[a, b)` (bracket depth 0, outside
/// string/template/regex/comment spans) for which `pred` holds, or `None`.
fn scan_top_level<F: Fn(&[char], usize) -> bool>(
	chars: &[char],
	a: usize,
	b: usize,
	pred: F,
) -> Option<usize> {
	let mut depth = 0i32;
	let mut prev_sig = '\0';
	let mut i = a;
	while i < b {
		if let Some(next) = skip_js_token(chars, i, prev_sig) {
			prev_sig = token_prev_sig(chars, i, prev_sig);
			i = next.min(b);
			continue;
		}
		let ch = chars[i];
		match ch {
			'(' | '[' | '{' => depth += 1,
			')' | ']' | '}' => depth -= 1,
			_ if depth == 0 && pred(chars, i) => return Some(i),
			_ => {}
		}
		if !ch.is_whitespace() {
			prev_sig = ch;
		}
		i += 1;
	}
	None
}

/// Split `[a, b)` into top-level comma-separated spans (nested brackets /
/// strings / templates / regex / comments respected). Holes / trailing commas
/// surface as empty spans.
fn split_top_level(chars: &[char], a: usize, b: usize) -> Vec<(usize, usize)> {
	let mut spans = Vec::new();
	let mut depth = 0i32;
	let mut prev_sig = '\0';
	let mut start = a;
	let mut i = a;
	while i < b {
		if let Some(next) = skip_js_token(chars, i, prev_sig) {
			prev_sig = token_prev_sig(chars, i, prev_sig);
			i = next.min(b);
			continue;
		}
		let ch = chars[i];
		match ch {
			'(' | '[' | '{' => depth += 1,
			')' | ']' | '}' => depth -= 1,
			',' if depth == 0 => {
				spans.push((start, i));
				start = i + 1;
			}
			_ => {}
		}
		if !ch.is_whitespace() {
			prev_sig = ch;
		}
		i += 1;
	}
	spans.push((start, b));
	spans
}

/// Index of a top-level default-assignment `=` in `[a, b)` (a lone `=`, not
/// `==`/`===`/`!=`/`<=`/`>=`/`=>`), or `None`.
fn find_default_eq(chars: &[char], a: usize, b: usize) -> Option<usize> {
	scan_top_level(chars, a, b, |c, i| {
		c[i] == '='
			&& c.get(i + 1).copied() != Some('=')
			&& c.get(i + 1).copied() != Some('>')
			&& (i == a || {
				let p = c[i - 1];
				p != '=' && p != '!' && p != '<' && p != '>'
			})
	})
}

/// Collect + validate the identifiers a destructuring `@let` pattern binds.
/// Errors (empty pattern, invalid/reserved/proto name) surface at parse.
fn collect_let_names(
	pattern: &[char],
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<Vec<String>, InkerError> {
	let mut out = Vec::new();
	collect_pattern_names(pattern, 0, pattern.len(), &mut out, line, column, template_path)?;
	if out.is_empty() {
		return Err(fail_invalid_expression(
			"let destructuring binds no variables",
			line,
			column,
			template_path,
		));
	}
	Ok(out)
}

/// Recurse over a binding target `[a, b)` (identifier, nested `{…}`/`[…]`
/// pattern, or a `target = default`), pushing each bound identifier into `out`.
fn collect_pattern_names(
	chars: &[char],
	a: usize,
	b: usize,
	out: &mut Vec<String>,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<(), InkerError> {
	let (a, b) = trim_range(chars, a, b);
	// A `target = default` binds only the target side.
	let (a, b) = match find_default_eq(chars, a, b) {
		Some(eq) => trim_range(chars, a, eq),
		None => (a, b),
	};
	if a >= b {
		return Ok(()); // array hole / empty
	}
	let first = chars[a];
	let last = chars[b - 1];
	if first == '{' && last == '}' {
		for (sa, sb) in split_top_level(chars, a + 1, b - 1) {
			collect_object_entry(chars, sa, sb, out, line, column, template_path)?;
		}
		return Ok(());
	}
	if first == '[' && last == ']' {
		for (sa, sb) in split_top_level(chars, a + 1, b - 1) {
			let (ea, eb) = trim_range(chars, sa, sb);
			let ea = if eb - ea >= 3 && chars[ea] == '.' && chars[ea + 1] == '.' && chars[ea + 2] == '.'
			{
				ea + 3
			} else {
				ea
			};
			collect_pattern_names(chars, ea, eb, out, line, column, template_path)?;
		}
		return Ok(());
	}
	push_binding_name(chars, a, b, out, line, column, template_path)
}

/// Handle one `{…}` entry: rest (`...target`), rename (`key: target`), or a
/// shorthand / defaulted key.
fn collect_object_entry(
	chars: &[char],
	a: usize,
	b: usize,
	out: &mut Vec<String>,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<(), InkerError> {
	let (a, b) = trim_range(chars, a, b);
	if a >= b {
		return Ok(()); // trailing comma
	}
	if b - a >= 3 && chars[a] == '.' && chars[a + 1] == '.' && chars[a + 2] == '.' {
		return collect_pattern_names(chars, a + 3, b, out, line, column, template_path);
	}
	let colon = scan_top_level(chars, a, b, |c, i| c[i] == ':');
	let eq = find_default_eq(chars, a, b);
	// `key: target` binds the target; `key` / `key = default` binds the key.
	match colon {
		Some(c) if eq.is_none_or(|e| c < e) => {
			collect_pattern_names(chars, c + 1, b, out, line, column, template_path)
		}
		_ => collect_pattern_names(chars, a, b, out, line, column, template_path),
	}
}

/// Advance past leading whitespace and `//`/`/* */` comments in `[a, b)`.
fn skip_trivia(chars: &[char], mut a: usize, b: usize) -> usize {
	while a < b {
		let c = chars[a];
		if c.is_whitespace() {
			a += 1;
			continue;
		}
		if c == '/' {
			match chars.get(a + 1).copied() {
				Some('/') => a = skip_line_comment(chars, a).min(b),
				Some('*') => a = skip_block_comment(chars, a).min(b),
				_ => break,
			}
			continue;
		}
		break;
	}
	a
}

/// Validate a leaf binding identifier in `[a, b)` (same guards as the simple
/// `@let` and `@each` binding paths) and push it. Leading/trailing whitespace
/// and comments (JS trivia) around the identifier are tolerated.
fn push_binding_name(
	chars: &[char],
	a: usize,
	b: usize,
	out: &mut Vec<String>,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> Result<(), InkerError> {
	let start = skip_trivia(chars, a, b);
	let mut end = start;
	while end < b && IDENT_CONT_RE.is_match(&chars[end].to_string()) {
		end += 1;
	}
	let name: String = chars[start..end].iter().collect();
	// Anything after the identifier must be trivia only.
	let rest_is_trivia = skip_trivia(chars, end, b) == b;
	if name.is_empty() || !rest_is_trivia {
		let raw: String = chars[a..b].iter().collect();
		return Err(fail_invalid_expression(
			format!("let destructuring binding '{}' is not a valid identifier", raw.trim()),
			line,
			column,
			template_path,
		));
	}
	if !BINDING_RE.is_match(&name) {
		return Err(fail_invalid_expression(
			format!("let destructuring binding '{name}' is not a valid identifier"),
			line,
			column,
			template_path,
		));
	}
	if is_reserved_binding(&name) {
		return Err(fail_invalid_expression(
			format!("let destructuring binding '{name}' is a reserved word"),
			line,
			column,
			template_path,
		));
	}
	if is_prototype_pollution_key(&name) {
		return Err(fail_invalid_expression(
			format!("let destructuring binding '{name}' is forbidden (prototype-pollution surface)"),
			line,
			column,
			template_path,
		));
	}
	out.push(name);
	Ok(())
}

#[allow(clippy::too_many_arguments)]
fn parse_include_if_tag(
	raw: &str,
	chars: &[char],
	line: u32,
	column: u32,
	template_path: Option<&str>,
	after_keyword: usize,
	helpers: &HashSet<String>,
	helper_id_start: u32,
) -> Result<(IfCondition, PartialNode, u32), InkerError> {
	let start = skip_whitespace(chars, after_keyword);
	if start >= chars.len() {
		return Err(fail_invalid_expression(
			"includeIf directive requires '<condition>, <name>'",
			line,
			column,
			template_path,
		));
	}
	let body = &chars[start..];
	let comma = match find_top_level_comma(body) {
		Some(c) => c,
		None => {
			return Err(fail_invalid_expression(
				"includeIf directive requires a comma between the condition and the quoted template name",
				line,
				column,
				template_path,
			));
		}
	};
	let cond_source: String =
		body[..comma].iter().collect::<String>().trim().to_string();
	if cond_source.is_empty() {
		return Err(fail_invalid_expression(
			"includeIf directive requires a condition before the comma",
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
		&cond_source,
		line,
		column,
		&options,
		helper_id_start,
	)?;

	let name_pos = skip_whitespace(chars, start + comma + 1);
	if name_pos >= chars.len() {
		return Err(fail_parse(
			"includeIf directive requires a quoted template name after the comma",
			line,
			column,
			template_path,
		));
	}
	let (name, next) =
		read_quoted_string(chars, name_pos, line, column, template_path)?;
	validate_path_name(&name, line, column, template_path)?;
	let after_name = skip_whitespace(chars, next);
	if after_name < chars.len() {
		let trailing: String = chars[next..].iter().collect();
		return Err(fail_parse(
			format!("Unexpected tokens after includeIf name: '{trailing}'"),
			line,
			column,
			template_path,
		));
	}
	Ok((
		IfCondition {
			expression,
			source: cond_source,
		},
		PartialNode {
			name,
			raw: raw.to_string(),
			line,
			column,
		},
		next_id,
	))
}

/// Locate the first top-level `,` in `s`, honoring string literals and
/// bracket/brace/paren nesting. Returns its index in `s`, or None.
fn find_top_level_comma(s: &[char]) -> Option<usize> {
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
		} else if c == ']' || c == ')' || c == '}' {
			depth -= 1;
		} else if c == ',' && depth == 0 {
			return Some(i);
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
			"each directive requires '<binding> in <iterable>'",
			line,
			column,
			template_path,
		));
	}

	let body = &chars[start..];
	let in_match = match find_top_level_in(body) {
		Some(m) => m,
		None => {
			return Err(fail_invalid_expression(
				"each directive requires '<binding> in <iterable>' — missing 'in' keyword",
				line,
				column,
				template_path,
			));
		}
	};

	let binding_src: String =
		body[..in_match.0].iter().collect::<String>().trim().to_string();
	if binding_src.is_empty() {
		return Err(fail_invalid_expression(
			"each directive requires a binding before 'in'",
			line,
			column,
			template_path,
		));
	}

	let iterable_source: String =
		body[in_match.1..].iter().collect::<String>().trim().to_string();
	if iterable_source.is_empty() {
		return Err(fail_invalid_expression(
			"each directive requires an iterable expression after 'in'",
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

	// `(value, index)` → Indexed; `[k, v]` → Destructured (array-of-pairs /
	// object entries); a bare identifier → Single.
	let binding = if binding_src.starts_with('(') {
		if !binding_src.ends_with(')') {
			return Err(fail_invalid_expression(
				"unbalanced parentheses in indexed each binding '(value, index)'",
				line,
				column,
				template_path,
			));
		}
		parse_indexed_binding(
			&binding_src[1..binding_src.len() - 1],
			line,
			column,
			template_path,
		)?
	} else if binding_src.starts_with('[') {
		// Parse the destructured binding from the ISOLATED `[k, v]` text so its
		// trailing-token check does not trip on the ` in <iterable>` that follows.
		let bchars: Vec<char> = binding_src.chars().collect();
		parse_destructured_binding(&bchars, 0, line, column, template_path)?
	} else {
		validate_each_ident(&binding_src, line, column, template_path)?;
		EachBinding::Single(binding_src)
	};

	Ok((iterable, iterable_source, binding, next_id))
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
	// Edge separates the component name from its args object with a comma:
	// `@component('name', { … })`. Accept (and skip) the optional comma.
	if chars.get(i).copied() == Some(',') {
		i = skip_whitespace(chars, i + 1);
	}
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
			body_nodes: Vec::new(),
			named_slots: Vec::new(),
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
	Section,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParsedBlockTag {
	Layout(LayoutNode),
	Partial(PartialNode),
	Component(ComponentNode),
	/// `@section('name')` — a named layout section (yield in a layout, fill in a
	/// child). Closed by `@endsection`.
	OpenSection {
		name: String,
		line: u32,
		column: u32,
	},
	/// `@super` — inside a child section, yields the layout's default content
	/// for the enclosing section. Self-closing.
	Super {
		line: u32,
		column: u32,
	},
	/// `@eval(expr)` — evaluate an expression for its side effects, emitting
	/// nothing. Self-closing.
	Eval {
		source: String,
		line: u32,
		column: u32,
	},
	/// `@dump(expr)` — pretty-print `expr` for debugging. Self-closing.
	Dump {
		source: String,
		line: u32,
		column: u32,
	},
	/// `@<name>(args)` — a runtime-registered custom tag (Edge `registerTag`).
	/// Self-closing; `args_source` is the raw expression list inside the parens.
	CustomTag {
		name: String,
		args_source: String,
		line: u32,
		column: u32,
	},
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
	ElseIf {
		condition: IfCondition,
		line: u32,
		column: u32,
	},
	Let {
		name: String,
		expression: Expression,
		source: String,
		destructure: bool,
		names: Vec<String>,
		line: u32,
		column: u32,
	},
	IncludeIf {
		condition: IfCondition,
		partial: PartialNode,
		line: u32,
		column: u32,
	},
	OpenSlot {
		name: String,
		line: u32,
		column: u32,
	},
	CloseSlot {
		line: u32,
		column: u32,
	},
	CloseComponent {
		line: u32,
		column: u32,
	},
}

#[derive(Debug, Default, Clone)]
pub struct ParseBlockTagOptions {
	pub template_path: Option<String>,
	pub helpers: HashSet<String>,
	/// Runtime-registered custom tag names (Edge `registerTag`).
	pub custom_tags: HashSet<String>,
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
	let (raw_keyword, after_keyword) = read_keyword(&chars, start_of_keyword);
	// Edge self-closing `@!component` reaches here as keyword `!component`. Strip
	// the `!` → a normal `component`; parse.rs's lookahead treats a component with
	// no matching `@endcomponent` as self-closing, which `@!component` always is.
	let keyword = if raw_keyword == "!component" {
		"component".to_string()
	} else {
		raw_keyword
	};

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
	// A runtime-registered custom tag (Edge `registerTag`): `@<name>(args)` →
	// a `CustomTag` node; the Node renderer evaluates the args and invokes the
	// registered handler. Built-in keywords take precedence.
	if !KNOWN_KEYWORDS.contains(keyword.as_str())
		&& options.custom_tags.contains(keyword.as_str())
	{
		let i = skip_whitespace(&chars, after_keyword);
		let args_source: String = chars[i..].iter().collect::<String>().trim().to_string();
		return Ok((
			ParsedBlockTag::CustomTag {
				name: keyword,
				args_source,
				line,
				column,
			},
			helper_id_start,
		));
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

	if keyword == "elseif" {
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
			ParsedBlockTag::ElseIf {
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

	if keyword == "unless" {
		// `@unless(cond)` = `@if(!(cond))` — parse the negated condition so the
		// block balances against `@endunless` (Close::If) exactly like if/endif.
		let args: String =
			chars[after_keyword..].iter().collect::<String>().trim().to_string();
		if args.is_empty() {
			return Err(fail_invalid_expression(
				"unless directive requires a condition",
				line,
				column,
				template_path,
			));
		}
		let negated: Vec<char> = format!("!({args})").chars().collect();
		let (condition, next_id) = parse_if_tag(
			&negated,
			line,
			column,
			template_path,
			0,
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

	if keyword == "endunless" {
		let trailing: String =
			chars[after_keyword..].iter().collect::<String>().trim().to_string();
		if !trailing.is_empty() {
			return Err(fail_parse(
				format!("Unexpected tokens after endunless: '{trailing}'"),
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
		// `@else` is accepted as a spelled-out `elseif` — chained
		// into the AST identically. The single-token `@elseif()` form is
		// handled above; this catches the space-separated spelling.
		let after_else = skip_whitespace(&chars, after_keyword);
		if after_else + 2 <= chars.len()
			&& chars[after_else] == 'i'
			&& chars.get(after_else + 1).copied() == Some('f')
			&& chars
				.get(after_else + 2)
				.map(|c| is_whitespace(*c))
				.unwrap_or(false)
		{
			let (condition, next_id) = parse_if_tag(
				&chars,
				line,
				column,
				template_path,
				after_else + 2,
				helpers,
				helper_id_start,
			)?;
			return Ok((
				ParsedBlockTag::ElseIf {
					condition,
					line,
					column,
				},
				next_id,
			));
		}
		let trailing: String = chars[after_keyword..].iter().collect::<String>().trim().to_string();
		if !trailing.is_empty() {
			return Err(fail_invalid_expression(
				format!(
					"Unexpected tokens after else: '{trailing}' — use '@elseif(<cond>)' (or '@elseif(<cond>)') for chained conditions"
				),
				line,
				column,
				template_path,
			));
		}
		return Ok((ParsedBlockTag::Else { line, column }, helper_id_start));
	}

	if keyword == "let" {
		let (name, expression, source, destructure, names, next_id) = parse_let_tag(
			&chars,
			line,
			column,
			template_path,
			after_keyword,
			helpers,
			helper_id_start,
		)?;
		return Ok((
			ParsedBlockTag::Let {
				name,
				expression,
				source,
				destructure,
				names,
				line,
				column,
			},
			next_id,
		));
	}

	if keyword == "includeIf" {
		let (condition, partial, next_id) = parse_include_if_tag(
			raw,
			&chars,
			line,
			column,
			template_path,
			after_keyword,
			helpers,
			helper_id_start,
		)?;
		return Ok((
			ParsedBlockTag::IncludeIf {
				condition,
				partial,
				line,
				column,
			},
			next_id,
		));
	}

	if keyword == "slot" {
		let after_kw_space = skip_whitespace(&chars, after_keyword);
		if after_kw_space >= chars.len() {
			return Err(fail_parse(
				"slot directive requires a quoted slot name",
				line,
				column,
				template_path,
			));
		}
		let (name, next) =
			read_quoted_string(&chars, after_kw_space, line, column, template_path)?;
		if !SLOT_NAME_RE.is_match(&name) {
			return Err(fail_parse(
				format!("Invalid slot name '{name}' — must match /^[a-zA-Z_][a-zA-Z0-9_-]*$/"),
				line,
				column,
				template_path,
			));
		}
		if name == "body" {
			return Err(fail_parse(
				"slot name 'body' is reserved for the default component body content",
				line,
				column,
				template_path,
			));
		}
		let after_name = skip_whitespace(&chars, next);
		if after_name < chars.len() {
			let trailing: String = chars[next..].iter().collect();
			return Err(fail_parse(
				format!("Unexpected tokens after slot name: '{trailing}'"),
				line,
				column,
				template_path,
			));
		}
		return Ok((ParsedBlockTag::OpenSlot { name, line, column }, helper_id_start));
	}

	if keyword == "endslot" {
		let trailing: String = chars[after_keyword..].iter().collect::<String>().trim().to_string();
		if !trailing.is_empty() {
			return Err(fail_parse(
				format!("Unexpected tokens after endslot: '{trailing}'"),
				line,
				column,
				template_path,
			));
		}
		return Ok((ParsedBlockTag::CloseSlot { line, column }, helper_id_start));
	}

	if keyword == "section" {
		let after_kw_space = skip_whitespace(&chars, after_keyword);
		if after_kw_space >= chars.len() {
			return Err(fail_parse(
				"section directive requires a quoted section name",
				line,
				column,
				template_path,
			));
		}
		let (name, next) =
			read_quoted_string(&chars, after_kw_space, line, column, template_path)?;
		if !SLOT_NAME_RE.is_match(&name) {
			return Err(fail_parse(
				format!("Invalid section name '{name}' — must match /^[a-zA-Z_][a-zA-Z0-9_-]*$/"),
				line,
				column,
				template_path,
			));
		}
		let after_name = skip_whitespace(&chars, next);
		if after_name < chars.len() {
			let trailing: String = chars[next..].iter().collect();
			return Err(fail_parse(
				format!("Unexpected tokens after section name: '{trailing}'"),
				line,
				column,
				template_path,
			));
		}
		return Ok((ParsedBlockTag::OpenSection { name, line, column }, helper_id_start));
	}

	if keyword == "endsection" {
		let trailing: String = chars[after_keyword..].iter().collect::<String>().trim().to_string();
		if !trailing.is_empty() {
			return Err(fail_parse(
				format!("Unexpected tokens after endsection: '{trailing}'"),
				line,
				column,
				template_path,
			));
		}
		return Ok((
			ParsedBlockTag::Close {
				closes: BlockClosesKind::Section,
				line,
				column,
			},
			helper_id_start,
		));
	}

	if keyword == "super" {
		let trailing: String = chars[after_keyword..].iter().collect::<String>().trim().to_string();
		if !trailing.is_empty() {
			return Err(fail_parse(
				format!("Unexpected tokens after super: '{trailing}'"),
				line,
				column,
				template_path,
			));
		}
		return Ok((ParsedBlockTag::Super { line, column }, helper_id_start));
	}

	if keyword == "eval" {
		let i = skip_whitespace(&chars, after_keyword);
		let source: String = chars[i..].iter().collect::<String>().trim().to_string();
		if source.is_empty() {
			return Err(fail_invalid_expression(
				"eval directive requires an expression",
				line,
				column,
				template_path,
			));
		}
		return Ok((ParsedBlockTag::Eval { source, line, column }, helper_id_start));
	}

	if keyword == "dump" {
		let i = skip_whitespace(&chars, after_keyword);
		let source: String = chars[i..].iter().collect::<String>().trim().to_string();
		if source.is_empty() {
			return Err(fail_invalid_expression(
				"dump directive requires an expression",
				line,
				column,
				template_path,
			));
		}
		return Ok((ParsedBlockTag::Dump { source, line, column }, helper_id_start));
	}

	if keyword == "endcomponent" {
		let trailing: String = chars[after_keyword..].iter().collect::<String>().trim().to_string();
		if !trailing.is_empty() {
			return Err(fail_parse(
				format!("Unexpected tokens after endcomponent: '{trailing}'"),
				line,
				column,
				template_path,
			));
		}
		return Ok((ParsedBlockTag::CloseComponent { line, column }, helper_id_start));
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
		let (pb, _) = parse_block_tag("each item in items", 1, 1, &opts(), 0).unwrap();
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
		let (pb, _) = parse_block_tag("each [k, v] in map", 1, 1, &opts(), 0).unwrap();
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
		// `block` is still reserved/unsupported; `section` is now supported (62-3).
		let e = parse_block_tag("block", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::UnknownDirective);
	}

	#[test]
	fn section_and_super_parse() {
		let (pb, _) = parse_block_tag("section 'scripts'", 1, 1, &opts(), 0).unwrap();
		assert!(matches!(pb, ParsedBlockTag::OpenSection { .. }));
		let (close, _) = parse_block_tag("endsection", 1, 1, &opts(), 0).unwrap();
		assert!(matches!(close, ParsedBlockTag::Close { closes: BlockClosesKind::Section, .. }));
		let (sup, _) = parse_block_tag("super", 1, 1, &opts(), 0).unwrap();
		assert!(matches!(sup, ParsedBlockTag::Super { .. }));
	}

	#[test]
	fn each_single_binding_proto_pollution_rejected() {
		let e = parse_block_tag("each __proto__ in items", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}

	#[test]
	fn each_destructured_binding_proto_pollution_rejected() {
		let e = parse_block_tag("each [__proto__, v] in items", 1, 1, &opts(), 0).unwrap_err();
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
			parse_block_tag("each item in sorted(items)", 1, 1, &o, 5).unwrap();
		match pb {
			ParsedBlockTag::OpenEach { .. } => {}
			_ => panic!("expected OpenEach"),
		}
		assert_eq!(next_id, 6, "helper id assigned starting from 5, advanced to 6");
	}

	#[test]
	fn destructured_binding_duplicate_rejected() {
		let e =
			parse_block_tag("each [k, k] in map", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}

	#[test]
	fn let_simple_binding_is_not_destructure() {
		let (pb, _) = parse_block_tag("let n = i + 1", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::Let { name, source, destructure, .. } => {
				assert_eq!(name, "n");
				assert_eq!(source, "i + 1");
				assert!(!destructure, "a bare identifier binding is not destructuring");
			}
			_ => panic!("expected Let"),
		}
	}

	#[test]
	fn let_object_destructure() {
		let (pb, _) = parse_block_tag("let { name, email } = user", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::Let { name, source, destructure, .. } => {
				assert!(destructure, "object pattern is a destructuring binding");
				assert_eq!(name, "{ name, email }", "pattern captured verbatim as name");
				assert_eq!(source, "user", "right-hand expression captured as source");
			}
			_ => panic!("expected Let"),
		}
	}

	#[test]
	fn let_array_destructure_with_rest() {
		let (pb, _) =
			parse_block_tag("let [first, second, ...rest] = items", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::Let { name, source, destructure, .. } => {
				assert!(destructure);
				assert_eq!(name, "[first, second, ...rest]");
				assert_eq!(source, "items");
			}
			_ => panic!("expected Let"),
		}
	}

	#[test]
	fn let_destructure_nested_default_keeps_inner_equals() {
		// The top-level `=` splits pattern/rhs; an inner default `= 1` stays inside
		// the balanced pattern (a bracket-depth question, not a JS-semantics one).
		let (pb, _) = parse_block_tag("let { a = 1, b } = obj", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::Let { name, source, destructure, .. } => {
				assert!(destructure);
				assert_eq!(name, "{ a = 1, b }");
				assert_eq!(source, "obj");
			}
			_ => panic!("expected Let"),
		}
	}

	#[test]
	fn let_destructure_missing_equals_rejected() {
		let e = parse_block_tag("let { a, b } obj", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::ParseError);
	}

	#[test]
	fn let_destructure_empty_rhs_rejected() {
		let e = parse_block_tag("let { a, b } =", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}

	fn let_names(src: &str) -> Vec<String> {
		match parse_block_tag(src, 1, 1, &opts(), 0).unwrap().0 {
			ParsedBlockTag::Let { names, .. } => names,
			_ => panic!("expected Let"),
		}
	}

	#[test]
	fn let_destructure_extracts_bound_names_at_parse() {
		assert_eq!(let_names("let { name, email } = user"), ["name", "email"]);
		assert_eq!(let_names("let [first, second, ...rest] = items"), ["first", "second", "rest"]);
		// rename binds the local; default binds the key; object rest included.
		assert_eq!(let_names("let { a: b, role = 'guest', ...others } = u"), ["b", "role", "others"]);
		// array hole contributes no name.
		assert_eq!(let_names("let [, x] = pair"), ["x"]);
		// nested pattern.
		assert_eq!(let_names("let { a: { b }, c: [d] } = o"), ["b", "d"]);
	}

	#[test]
	fn let_destructure_regex_default_with_comma_is_not_mis_split() {
		// The `,` inside `/x,y/` must NOT split the pattern — a JS-aware scanner
		// skips the regex literal (review 62-2: closes the lexer blind spot).
		assert_eq!(let_names("let { a = /x,y/, b } = obj"), ["a", "b"]);
		// bracket inside a regex default must not fool the pattern balancer.
		let (pb, _) = parse_block_tag("let { a = /}/.test(s), b } = obj", 1, 1, &opts(), 0).unwrap();
		match pb {
			ParsedBlockTag::Let { name, names, .. } => {
				assert_eq!(name, "{ a = /}/.test(s), b }");
				assert_eq!(names, ["a", "b"]);
			}
			_ => panic!("expected Let"),
		}
	}

	#[test]
	fn let_destructure_template_and_comment_defaults_are_not_mis_split() {
		// nested `${…}` template with an inner comma, and a block comment.
		assert_eq!(let_names("let { a = `${x},${y}`, b } = obj"), ["a", "b"]);
		assert_eq!(let_names("let { a /* , */, b } = obj"), ["a", "b"]);
	}

	#[test]
	fn let_destructure_rejects_proto_binding() {
		let e = parse_block_tag("let { __proto__ } = payload", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}

	#[test]
	fn let_destructure_rejects_reserved_binding() {
		// `this` is a reserved binding name (parity with the simple `@let` path).
		let e = parse_block_tag("let { this } = o", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}

	#[test]
	fn let_destructure_empty_pattern_binds_nothing_rejected() {
		let e = parse_block_tag("let {} = obj", 1, 1, &opts(), 0).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}
}
