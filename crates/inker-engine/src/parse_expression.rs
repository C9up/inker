//! Expression parser — mirrors `packages/inker/src/parseExpression.ts` 1:1.
//!
//! Recursive-descent with precedence climbing. Grammar covers:
//!   - Literal: string ('...' / "..."), number (int/dec, optional leading `-`),
//!     boolean (true/false), null, undefined.
//!   - Path: identifier with dot/bracket chain (delegates to `parse_path::parse_path`).
//!   - Call: `name(arg, …)` with helper-name set check.
//!   - Object: `{ key: value, shorthand, … }` (no prototype-pollution keys,
//!     no `{true}` reserved-shadow shorthand).
//!   - Unary: leading `!` and `await`.
//!   - Binary: `==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, `>=`, `&&`, `||`.
//!   - Group: `(expr)`.
//!
//! Each `Call` is assigned a monotonic `id: u32` during parse via the cursor's
//! `next_helper_id` counter — the id is the keyspace for ADR-007 helper
//! pre-resolution at render time (the TS-side walks the `collectInvocations`
//! tape, evaluates args, packs `Record<String(id), ResolvedHelperValue>`, and
//! the Rust renderer dereferences by id).

use crate::error::{ErrorCode, InkerError};
use crate::identifiers::{is_prototype_pollution_key, is_reserved_binding};
use crate::parse_path::{parse_path, PathSegment};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum BinaryOp {
    Eq,
    NotEq,
    StrictEq,
    StrictNotEq,
    Lt,
    Lte,
    Gt,
    Gte,
    And,
    Or,
}

impl BinaryOp {
    pub fn as_str(self) -> &'static str {
        match self {
            BinaryOp::Eq => "==",
            BinaryOp::NotEq => "!=",
            BinaryOp::StrictEq => "===",
            BinaryOp::StrictNotEq => "!==",
            BinaryOp::Lt => "<",
            BinaryOp::Lte => "<=",
            BinaryOp::Gt => ">",
            BinaryOp::Gte => ">=",
            BinaryOp::And => "&&",
            BinaryOp::Or => "||",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UnaryOp {
    Not,
    /// `await expr`. The Node renderer evaluates the expression's verbatim
    /// source in V8, so parsing it here is about validating the operand and
    /// collecting its helper call-sites — the suspension is the walker's job.
    Await,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", content = "value")]
pub enum LiteralValue {
    String(String),
    Number(f64),
    Bool(bool),
    Null,
    Undefined,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ObjectEntry {
    pub key: String,
    pub value: Expression,
    pub shorthand: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum Expression {
    Literal {
        value: LiteralValue,
        source: String,
        line: u32,
        column: u32,
    },
    Path {
        path: Vec<PathSegment>,
        source: String,
        line: u32,
        column: u32,
    },
    Call {
        name: String,
        args: Vec<Expression>,
        id: u32,
        source: String,
        line: u32,
        column: u32,
    },
    Object {
        entries: Vec<ObjectEntry>,
        source: String,
        line: u32,
        column: u32,
    },
    Unary {
        op: UnaryOp,
        operand: Box<Expression>,
        source: String,
        line: u32,
        column: u32,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expression>,
        right: Box<Expression>,
        source: String,
        line: u32,
        column: u32,
    },
    Group {
        expression: Box<Expression>,
        source: String,
        line: u32,
        column: u32,
    },
    /// A full-JS expression the restricted grammar does not model (method
    /// calls, ternary, arrow fns, arithmetic, arrays, …). The source is
    /// captured verbatim and evaluated by the Node renderer in V8, with the
    /// registered helpers and the render scope in scope (62-2 Edge pivot — no
    /// embedded JS VM). May reference helpers (`filter(u => can(u))`); an
    /// E_UNKNOWN helper is still rejected at parse time (see `raw_fallback`).
    Raw {
        source: String,
        line: u32,
        column: u32,
    },
}

impl Expression {
    pub fn source(&self) -> &str {
        match self {
            Expression::Literal { source, .. }
            | Expression::Path { source, .. }
            | Expression::Call { source, .. }
            | Expression::Object { source, .. }
            | Expression::Unary { source, .. }
            | Expression::Binary { source, .. }
            | Expression::Group { source, .. }
            | Expression::Raw { source, .. } => source,
        }
    }

    pub fn line(&self) -> u32 {
        match self {
            Expression::Literal { line, .. }
            | Expression::Path { line, .. }
            | Expression::Call { line, .. }
            | Expression::Object { line, .. }
            | Expression::Unary { line, .. }
            | Expression::Binary { line, .. }
            | Expression::Group { line, .. }
            | Expression::Raw { line, .. } => *line,
        }
    }

    pub fn column(&self) -> u32 {
        match self {
            Expression::Literal { column, .. }
            | Expression::Path { column, .. }
            | Expression::Call { column, .. }
            | Expression::Object { column, .. }
            | Expression::Unary { column, .. }
            | Expression::Binary { column, .. }
            | Expression::Group { column, .. }
            | Expression::Raw { column, .. } => *column,
        }
    }

    /// Walk the expression tree depth-first and collect every Call site
    /// (used by ADR-007 pre-resolution at render time).
    pub fn collect_call_sites<'a>(&'a self, out: &mut Vec<&'a Expression>) {
        match self {
            Expression::Call { args, .. } => {
                out.push(self);
                for a in args {
                    a.collect_call_sites(out);
                }
            }
            Expression::Object { entries, .. } => {
                for e in entries {
                    e.value.collect_call_sites(out);
                }
            }
            Expression::Unary { operand, .. } => operand.collect_call_sites(out),
            Expression::Binary { left, right, .. } => {
                left.collect_call_sites(out);
                right.collect_call_sites(out);
            }
            Expression::Group { expression, .. } => expression.collect_call_sites(out),
            // `Raw` is helper-free by construction (only emitted when the source
            // contains no registered helper call), so it has no call sites.
            Expression::Literal { .. } | Expression::Path { .. } | Expression::Raw { .. } => {}
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct ParseExpressionOptions {
    pub template_path: Option<String>,
    pub helpers: HashSet<String>,
}

static IDENT_START: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z_$]$").expect("static regex"));
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

const LITERAL_KEYWORDS: &[&str] = &["true", "false", "null", "undefined"];
fn is_literal_keyword(name: &str) -> bool {
    LITERAL_KEYWORDS.contains(&name)
}

const MAX_EXPRESSION_DEPTH: u32 = 256;

struct Cursor<'a> {
    source: &'a str,
    chars: Vec<char>,
    pos: usize,
    base_line: u32,
    base_column: u32,
    template_path: Option<String>,
    helpers: &'a HashSet<String>,
    depth: u32,
    next_helper_id: u32,
}

fn make_cursor<'a>(
    source: &'a str,
    line: u32,
    column: u32,
    options: &'a ParseExpressionOptions,
) -> Cursor<'a> {
    Cursor {
        source,
        chars: source.chars().collect(),
        pos: 0,
        base_line: line,
        base_column: column,
        template_path: options.template_path.clone(),
        helpers: &options.helpers,
        depth: 0,
        next_helper_id: 0,
    }
}

fn position_at(cursor: &Cursor, offset: usize) -> (u32, u32) {
    let mut line = cursor.base_line;
    let mut column = cursor.base_column;
    let end = offset.min(cursor.chars.len());
    for i in 0..end {
        let c = cursor.chars[i];
        if c == '\n' {
            line += 1;
            column = 1;
        } else if c == '\r' {
            // CR invisible — LF performs the break.
        } else {
            column += 1;
        }
    }
    (line, column)
}

fn fail_with_code(
    cursor: &Cursor,
    code: ErrorCode,
    reason: impl Into<String>,
    offset: usize,
) -> InkerError {
    let (line, column) = position_at(cursor, offset);
    let reason = reason.into();
    let mut e = InkerError::new(
        code,
        format!(
            "Expression '{}': {} (at character {} of the expression). At line {}, column {}.",
            cursor.source,
            reason,
            offset + 1,
            line,
            column
        ),
    )
    .with_pos(line, column)
    .with_expr(cursor.source);
    if let Some(name) = &cursor.template_path {
        e = e.with_template(name.clone());
    }
    e
}

fn fail_parse(cursor: &Cursor, reason: impl Into<String>, offset: usize) -> InkerError {
    fail_with_code(cursor, ErrorCode::ParseError, reason, offset)
}

fn fail_invalid_expression(
    cursor: &Cursor,
    reason: impl Into<String>,
    offset: usize,
) -> InkerError {
    fail_with_code(cursor, ErrorCode::InvalidExpression, reason, offset)
}

fn fail_unknown_helper(cursor: &Cursor, name: &str, offset: usize) -> InkerError {
    let (line, column) = position_at(cursor, offset);
    let mut registered: Vec<&String> = cursor.helpers.iter().collect();
    registered.sort();
    let shown: Vec<&str> = registered.iter().take(5).map(|s| s.as_str()).collect();
    let shown = shown.join(", ");
    let overflow = if registered.len() > 5 { ", …" } else { "" };
    let hint = if registered.is_empty() {
        "no helpers are registered".to_string()
    } else {
        format!("registered helpers: {shown}{overflow}")
    };
    let mut e = InkerError::new(
        ErrorCode::UnknownHelper,
        format!("Unknown helper '{name}' at line {line}, column {column} — {hint}"),
    )
    .with_pos(line, column)
    .with_expr(name);
    if let Some(t) = &cursor.template_path {
        e = e.with_template(t.clone());
    }
    e
}

fn skip_whitespace(cursor: &mut Cursor) {
    while cursor.pos < cursor.chars.len() {
        let c = cursor.chars[cursor.pos];
        if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
            cursor.pos += 1;
            continue;
        }
        break;
    }
}

fn read_identifier(cursor: &mut Cursor) -> Result<String, InkerError> {
    let start = cursor.pos;
    if cursor.pos >= cursor.chars.len() || !is_ident_start(cursor.chars[cursor.pos]) {
        return Err(fail_parse(cursor, "expected identifier", cursor.pos));
    }
    cursor.pos += 1;
    while cursor.pos < cursor.chars.len() && is_ident_cont(cursor.chars[cursor.pos]) {
        cursor.pos += 1;
    }
    Ok(cursor.chars[start..cursor.pos].iter().collect())
}

fn read_string_literal(cursor: &mut Cursor, quote: char) -> Result<String, InkerError> {
    let mut out = String::new();
    cursor.pos += 1; // consume opening quote
    while cursor.pos < cursor.chars.len() {
        let c = cursor.chars[cursor.pos];
        if c == '\\' {
            if cursor.pos + 1 >= cursor.chars.len() {
                return Err(fail_parse(
                    cursor,
                    "unterminated escape inside string literal",
                    cursor.pos,
                ));
            }
            let next = cursor.chars[cursor.pos + 1];
            match next {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                '\\' => out.push('\\'),
                '\'' => out.push('\''),
                '"' => out.push('"'),
                _ => {
                    return Err(fail_parse(
						cursor,
						format!(
							"unsupported escape sequence '\\{next}' inside string literal (only \\n, \\t, \\\\, \\', \\\" allowed)"
						),
						cursor.pos,
					));
                }
            }
            cursor.pos += 2;
            continue;
        }
        if c == quote {
            cursor.pos += 1;
            return Ok(out);
        }
        out.push(c);
        cursor.pos += 1;
    }
    Err(fail_parse(
        cursor,
        "unterminated string literal",
        cursor.pos,
    ))
}

fn read_number_source(cursor: &mut Cursor) -> Result<String, InkerError> {
    let start = cursor.pos;
    if cursor.chars.get(cursor.pos) == Some(&'-') {
        cursor.pos += 1;
    }
    if cursor.pos >= cursor.chars.len() || !is_digit(cursor.chars[cursor.pos]) {
        return Err(fail_parse(
            cursor,
            "expected digit after '-' in number literal",
            start,
        ));
    }
    while cursor.pos < cursor.chars.len() && is_digit(cursor.chars[cursor.pos]) {
        cursor.pos += 1;
    }
    if cursor.chars.get(cursor.pos) == Some(&'.') {
        cursor.pos += 1;
        let frac_start = cursor.pos;
        while cursor.pos < cursor.chars.len() && is_digit(cursor.chars[cursor.pos]) {
            cursor.pos += 1;
        }
        if cursor.pos == frac_start {
            return Err(fail_parse(
                cursor,
                "expected digit after '.' in number literal",
                cursor.pos,
            ));
        }
    }
    let next = cursor.chars.get(cursor.pos).copied();
    if next == Some('.') {
        return Err(fail_parse(
            cursor,
            "invalid number literal — multiple dots",
            cursor.pos,
        ));
    }
    if let Some(nc) = next {
        if nc.is_ascii_alphabetic() || nc == '_' || nc == '$' {
            return Err(fail_parse(
				cursor,
				"invalid number literal — only integer and decimal forms supported (no exponent / hex / octal / binary / BigInt)",
				cursor.pos,
			));
        }
    }
    Ok(cursor.chars[start..cursor.pos].iter().collect())
}

/// Number.MAX_SAFE_INTEGER = 2^53 − 1 = 9007199254740991.
const MAX_SAFE_INTEGER_F64: f64 = 9_007_199_254_740_991.0;

fn validate_number_magnitude(
    cursor: &Cursor,
    source: &str,
    value: f64,
    start_offset: usize,
) -> Result<(), InkerError> {
    if !value.is_finite() {
        return Err(fail_parse(
            cursor,
            format!("invalid number literal '{source}' — not a finite number"),
            start_offset,
        ));
    }
    if value.abs() > MAX_SAFE_INTEGER_F64 {
        return Err(fail_parse(
			cursor,
			format!(
				"number literal '{source}' exceeds Number.MAX_SAFE_INTEGER ({}) — comparisons would silently lose precision",
				MAX_SAFE_INTEGER_F64 as u64
			),
			start_offset,
		));
    }
    Ok(())
}

/// Scan forwards from cursor.pos through any `.ident` / `[…]` segments and
/// return the position AFTER the last consumed segment. The cursor itself is
/// NOT moved. Handles nested brackets and bracket-strings.
fn scan_path_tail(cursor: &Cursor) -> Result<usize, InkerError> {
    let mut i = cursor.pos;
    let len = cursor.chars.len();
    while i < len {
        let c = cursor.chars[i];
        if c == '.' {
            if cursor.chars.get(i + 1) == Some(&'.') {
                break;
            }
            i += 1;
            while i < len && is_ident_cont(cursor.chars[i]) {
                i += 1;
            }
            continue;
        }
        if c == '[' {
            let bracket_open = i;
            let mut depth = 1;
            i += 1;
            while i < len && depth > 0 {
                let cc = cursor.chars[i];
                if cc == '"' || cc == '\'' {
                    let quote = cc;
                    i += 1;
                    while i < len {
                        let ic = cursor.chars[i];
                        if ic == '\\' {
                            i += 2;
                            continue;
                        }
                        if ic == quote {
                            i += 1;
                            break;
                        }
                        i += 1;
                    }
                    continue;
                }
                if cc == '[' {
                    depth += 1;
                } else if cc == ']' {
                    depth -= 1;
                }
                i += 1;
            }
            if depth > 0 {
                return Err(fail_parse(
                    cursor,
                    "unterminated '[' in path expression",
                    bracket_open,
                ));
            }
            continue;
        }
        break;
    }
    Ok(i)
}

fn parse_primary(cursor: &mut Cursor) -> Result<Expression, InkerError> {
    cursor.depth += 1;
    if cursor.depth > MAX_EXPRESSION_DEPTH {
        let pos = cursor.pos;
        let e = fail_parse(
			cursor,
			format!(
				"expression nests beyond the maximum depth of {MAX_EXPRESSION_DEPTH} — flatten the expression or move logic to a helper"
			),
			pos,
		);
        cursor.depth -= 1;
        return Err(e);
    }
    let res = parse_primary_inner(cursor);
    cursor.depth -= 1;
    res
}

fn parse_primary_inner(cursor: &mut Cursor) -> Result<Expression, InkerError> {
    skip_whitespace(cursor);
    let start = cursor.pos;
    let (start_line, start_column) = position_at(cursor, start);

    let c = match cursor.chars.get(cursor.pos).copied() {
        Some(c) => c,
        None => {
            return Err(fail_parse(
                cursor,
                "unexpected end of expression",
                cursor.pos,
            ));
        }
    };

    if c == '\'' || c == '"' {
        let value = read_string_literal(cursor, c)?;
        let src: String = cursor.chars[start..cursor.pos].iter().collect();
        return Ok(Expression::Literal {
            value: LiteralValue::String(value),
            source: src,
            line: start_line,
            column: start_column,
        });
    }

    if c == '-' {
        let next = cursor.chars.get(cursor.pos + 1).copied();
        if next.is_some_and(is_digit) {
            let source = read_number_source(cursor)?;
            let value: f64 = source
                .parse()
                .map_err(|_| fail_parse(cursor, "invalid number literal", start))?;
            validate_number_magnitude(cursor, &source, value, start)?;
            return Ok(Expression::Literal {
                value: LiteralValue::Number(value),
                source,
                line: start_line,
                column: start_column,
            });
        }
        return Err(fail_parse(
            cursor,
            "unary minus is not supported — use a numeric literal or a path",
            cursor.pos,
        ));
    }

    if is_digit(c) {
        let source = read_number_source(cursor)?;
        let value: f64 = source
            .parse()
            .map_err(|_| fail_parse(cursor, "invalid number literal", start))?;
        validate_number_magnitude(cursor, &source, value, start)?;
        return Ok(Expression::Literal {
            value: LiteralValue::Number(value),
            source,
            line: start_line,
            column: start_column,
        });
    }

    if c == '(' {
        cursor.pos += 1;
        skip_whitespace(cursor);
        let inner = parse_or(cursor)?;
        skip_whitespace(cursor);
        if cursor.chars.get(cursor.pos) != Some(&')') {
            return Err(fail_parse(
                cursor,
                "expected ')' to close grouping",
                cursor.pos,
            ));
        }
        cursor.pos += 1;
        let src: String = cursor.chars[start..cursor.pos].iter().collect();
        return Ok(Expression::Group {
            expression: Box::new(inner),
            source: src,
            line: start_line,
            column: start_column,
        });
    }

    if c == '{' {
        return parse_object_literal(cursor, start, start_line, start_column);
    }

    if c == '[' {
        return Err(fail_parse(
			cursor,
			"array literals are not supported in expression position — they are only valid as destructuring bindings in `@each([k, v] in items)`",
			cursor.pos,
		));
    }

    if is_ident_start(c) {
        let ident_start = cursor.pos;
        let name = read_identifier(cursor)?;

        if is_literal_keyword(&name) {
            let value = match name.as_str() {
                "true" => LiteralValue::Bool(true),
                "false" => LiteralValue::Bool(false),
                "null" => LiteralValue::Null,
                "undefined" => LiteralValue::Undefined,
                _ => unreachable!("checked by is_literal_keyword"),
            };
            return Ok(Expression::Literal {
                value,
                source: name,
                line: start_line,
                column: start_column,
            });
        }

        // Function call — `name(` IMMEDIATELY (no whitespace tolerance).
        if cursor.chars.get(cursor.pos) == Some(&'(') {
            if !cursor.helpers.contains(&name) {
                return Err(fail_unknown_helper(cursor, &name, ident_start));
            }
            cursor.pos += 1;
            let args = parse_call_args(cursor)?;
            let id = cursor.next_helper_id;
            cursor.next_helper_id += 1;
            let src: String = cursor.chars[start..cursor.pos].iter().collect();
            return Ok(Expression::Call {
                name,
                args,
                id,
                source: src,
                line: start_line,
                column: start_column,
            });
        }

        let path_end = scan_path_tail(cursor)?;
        let path_source: String = cursor.chars[ident_start..path_end].iter().collect();
        let path = parse_path(&path_source, start_line, start_column)?;
        cursor.pos = path_end;
        return Ok(Expression::Path {
            path,
            source: path_source,
            line: start_line,
            column: start_column,
        });
    }

    Err(fail_parse(
        cursor,
        format!("unexpected character '{c}' at start of expression"),
        cursor.pos,
    ))
}

fn parse_call_args(cursor: &mut Cursor) -> Result<Vec<Expression>, InkerError> {
    let mut args: Vec<Expression> = Vec::new();
    skip_whitespace(cursor);
    if cursor.chars.get(cursor.pos) == Some(&')') {
        cursor.pos += 1;
        return Ok(args);
    }
    loop {
        skip_whitespace(cursor);
        let here = cursor.chars.get(cursor.pos).copied();
        if here == Some(',') {
            return Err(fail_parse(
                cursor,
                "unexpected ',' — empty argument position",
                cursor.pos,
            ));
        }
        if here == Some(')') {
            return Err(fail_parse(
                cursor,
                "unexpected ')' — trailing comma is not allowed in call args",
                cursor.pos,
            ));
        }
        args.push(parse_or(cursor)?);
        skip_whitespace(cursor);
        let next = cursor.chars.get(cursor.pos).copied();
        match next {
            Some(',') => {
                cursor.pos += 1;
            }
            Some(')') => {
                cursor.pos += 1;
                return Ok(args);
            }
            other => {
                let other_s = other.map(|c| c.to_string()).unwrap_or_else(|| "EOF".into());
                return Err(fail_parse(
                    cursor,
                    format!("expected ',' or ')' in call arguments, got '{other_s}'"),
                    cursor.pos,
                ));
            }
        }
    }
}

fn parse_object_literal(
    cursor: &mut Cursor,
    start: usize,
    start_line: u32,
    start_column: u32,
) -> Result<Expression, InkerError> {
    cursor.pos += 1; // consume `{`
    let mut entries: Vec<ObjectEntry> = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();
    skip_whitespace(cursor);

    if cursor.chars.get(cursor.pos) == Some(&'}') {
        cursor.pos += 1;
        let src: String = cursor.chars[start..cursor.pos].iter().collect();
        return Ok(Expression::Object {
            entries,
            source: src,
            line: start_line,
            column: start_column,
        });
    }

    loop {
        skip_whitespace(cursor);
        if cursor.chars.get(cursor.pos) == Some(&',') {
            return Err(fail_parse(
                cursor,
                "unexpected ',' — leading comma in object literal",
                cursor.pos,
            ));
        }
        let key_start = cursor.pos;
        let key_first = cursor.chars.get(cursor.pos).copied();
        if key_first.is_none() || !is_ident_start(key_first.unwrap()) {
            let kfs = key_first
                .map(|c| c.to_string())
                .unwrap_or_else(|| "EOF".into());
            return Err(fail_parse(
                cursor,
                format!("expected object key identifier, got '{kfs}'"),
                cursor.pos,
            ));
        }
        let key = read_identifier(cursor)?;
        if is_prototype_pollution_key(&key) {
            return Err(fail_invalid_expression(
                cursor,
                format!("object key '{key}' is a prototype-pollution surface — forbidden"),
                key_start,
            ));
        }
        if seen_keys.contains(&key) {
            return Err(fail_parse(
                cursor,
                format!("duplicate object key '{key}'"),
                key_start,
            ));
        }
        seen_keys.insert(key.clone());

        skip_whitespace(cursor);
        let after = cursor.chars.get(cursor.pos).copied();

        match after {
            Some(':') => {
                cursor.pos += 1;
                skip_whitespace(cursor);
                let value = parse_or(cursor)?;
                entries.push(ObjectEntry {
                    key,
                    value,
                    shorthand: false,
                });
            }
            Some('.') | Some('[') => {
                return Err(fail_parse(
					cursor,
					format!(
						"object shorthand value must be a bare identifier — dotted/bracket paths require explicit 'key: path' (key was '{key}')"
					),
					key_start,
				));
            }
            Some(',') | Some('}') => {
                if is_literal_keyword(&key) || is_reserved_binding(&key) {
                    return Err(fail_invalid_expression(
                        cursor,
                        format!(
							"object shorthand '{key}' shadows a literal/reserved keyword — use 'key: value' explicitly"
						),
                        key_start,
                    ));
                }
                let (key_line, key_col) = position_at(cursor, key_start);
                let path_expr = Expression::Path {
                    path: vec![PathSegment::Key(key.clone())],
                    source: key.clone(),
                    line: key_line,
                    column: key_col,
                };
                entries.push(ObjectEntry {
                    key,
                    value: path_expr,
                    shorthand: true,
                });
            }
            other => {
                let other_s = other.map(|c| c.to_string()).unwrap_or_else(|| "EOF".into());
                return Err(fail_parse(
                    cursor,
                    format!(
                        "expected ':' or ',' or '}}' after object key '{key}', got '{other_s}'"
                    ),
                    cursor.pos,
                ));
            }
        }

        skip_whitespace(cursor);
        let sep = cursor.chars.get(cursor.pos).copied();
        match sep {
            Some(',') => {
                cursor.pos += 1;
                skip_whitespace(cursor);
                if cursor.chars.get(cursor.pos) == Some(&'}') {
                    cursor.pos += 1;
                    let src: String = cursor.chars[start..cursor.pos].iter().collect();
                    return Ok(Expression::Object {
                        entries,
                        source: src,
                        line: start_line,
                        column: start_column,
                    });
                }
                continue;
            }
            Some('}') => {
                cursor.pos += 1;
                let src: String = cursor.chars[start..cursor.pos].iter().collect();
                return Ok(Expression::Object {
                    entries,
                    source: src,
                    line: start_line,
                    column: start_column,
                });
            }
            other => {
                let other_s = other.map(|c| c.to_string()).unwrap_or_else(|| "EOF".into());
                return Err(fail_parse(
                    cursor,
                    format!("expected ',' or '}}' in object literal, got '{other_s}'"),
                    cursor.pos,
                ));
            }
        }
    }
}

/// Does `word` sit at the cursor as a whole keyword — followed by something
/// that cannot continue an identifier?
fn matches_keyword(cursor: &Cursor, word: &str) -> bool {
    let chars: Vec<char> = word.chars().collect();
    if cursor.pos + chars.len() > cursor.chars.len() {
        return false;
    }
    if cursor.chars[cursor.pos..cursor.pos + chars.len()] != chars[..] {
        return false;
    }
    match cursor.chars.get(cursor.pos + chars.len()) {
        None => false,
        Some(c) => !(c.is_alphanumeric() || *c == '_' || *c == '$'),
    }
}

fn parse_unary(cursor: &mut Cursor) -> Result<Expression, InkerError> {
    skip_whitespace(cursor);
    let start = cursor.pos;
    let (start_line, start_column) = position_at(cursor, start);
    // `await expr` — a keyword, so it must be followed by a boundary; `awaited`
    // and `await_at` are ordinary identifiers.
    if matches_keyword(cursor, "await") {
        cursor.depth += 1;
        if cursor.depth > MAX_EXPRESSION_DEPTH {
            let pos = cursor.pos;
            let e = fail_parse(
				cursor,
				format!(
					"expression nests beyond the maximum depth of {MAX_EXPRESSION_DEPTH} — flatten the expression or move logic to a helper"
				),
				pos,
			);
            cursor.depth -= 1;
            return Err(e);
        }
        cursor.pos += "await".len();
        let operand = parse_unary(cursor)?;
        cursor.depth -= 1;
        let src: String = cursor.chars[start..cursor.pos].iter().collect();
        return Ok(Expression::Unary {
            op: UnaryOp::Await,
            operand: Box::new(operand),
            source: src,
            line: start_line,
            column: start_column,
        });
    }
    if cursor.chars.get(cursor.pos) == Some(&'!') && cursor.chars.get(cursor.pos + 1) != Some(&'=')
    {
        // Bound the unary `!` chain with the same depth budget parse_primary uses.
        // parse_unary recurses on each leading `!`, and the parse_primary guard is
        // only reached at the leaf operand — so an unguarded `!!!…!x` chain would
        // overflow the native stack and abort the process across the NAPI boundary
        // (catch_unwind cannot recover a stack overflow), unlike the JS engine's
        // catchable RangeError.
        cursor.depth += 1;
        if cursor.depth > MAX_EXPRESSION_DEPTH {
            let pos = cursor.pos;
            let e = fail_parse(
				cursor,
				format!(
					"expression nests beyond the maximum depth of {MAX_EXPRESSION_DEPTH} — flatten the expression or move logic to a helper"
				),
				pos,
			);
            cursor.depth -= 1;
            return Err(e);
        }
        cursor.pos += 1;
        let operand = parse_unary(cursor)?;
        cursor.depth -= 1;
        let src: String = cursor.chars[start..cursor.pos].iter().collect();
        return Ok(Expression::Unary {
            op: UnaryOp::Not,
            operand: Box::new(operand),
            source: src,
            line: start_line,
            column: start_column,
        });
    }
    parse_primary(cursor)
}

fn try_read_binary_op(cursor: &mut Cursor) -> Result<Option<BinaryOp>, InkerError> {
    let c = match cursor.chars.get(cursor.pos).copied() {
        Some(c) => c,
        None => return Ok(None),
    };

    if c == '=' {
        if cursor.chars.get(cursor.pos + 1) == Some(&'=') {
            if cursor.chars.get(cursor.pos + 2) == Some(&'=') {
                cursor.pos += 3;
                return Ok(Some(BinaryOp::StrictEq));
            }
            cursor.pos += 2;
            return Ok(Some(BinaryOp::Eq));
        }
        return Err(fail_parse(
            cursor,
            "unexpected '=' — use '==' or '===' for equality",
            cursor.pos,
        ));
    }
    if c == '!' {
        if cursor.chars.get(cursor.pos + 1) == Some(&'=') {
            if cursor.chars.get(cursor.pos + 2) == Some(&'=') {
                cursor.pos += 3;
                return Ok(Some(BinaryOp::StrictNotEq));
            }
            cursor.pos += 2;
            return Ok(Some(BinaryOp::NotEq));
        }
        return Ok(None);
    }
    if c == '<' {
        if cursor.chars.get(cursor.pos + 1) == Some(&'=') {
            cursor.pos += 2;
            return Ok(Some(BinaryOp::Lte));
        }
        cursor.pos += 1;
        return Ok(Some(BinaryOp::Lt));
    }
    if c == '>' {
        if cursor.chars.get(cursor.pos + 1) == Some(&'=') {
            cursor.pos += 2;
            return Ok(Some(BinaryOp::Gte));
        }
        cursor.pos += 1;
        return Ok(Some(BinaryOp::Gt));
    }
    if c == '&' {
        if cursor.chars.get(cursor.pos + 1) == Some(&'&') {
            cursor.pos += 2;
            return Ok(Some(BinaryOp::And));
        }
        return Err(fail_parse(
            cursor,
            "bitwise '&' is not supported — use '&&' for logical AND",
            cursor.pos,
        ));
    }
    if c == '|' {
        if cursor.chars.get(cursor.pos + 1) == Some(&'|') {
            cursor.pos += 2;
            return Ok(Some(BinaryOp::Or));
        }
        return Err(fail_parse(
            cursor,
            "bitwise '|' is not supported — use '||' for logical OR",
            cursor.pos,
        ));
    }
    Ok(None)
}

fn precedence_of(op: BinaryOp) -> u32 {
    match op {
        BinaryOp::Or => 1,
        BinaryOp::And => 2,
        BinaryOp::Eq | BinaryOp::NotEq | BinaryOp::StrictEq | BinaryOp::StrictNotEq => 3,
        BinaryOp::Lt | BinaryOp::Lte | BinaryOp::Gt | BinaryOp::Gte => 4,
    }
}

fn parse_binary(cursor: &mut Cursor, min_precedence: u32) -> Result<Expression, InkerError> {
    let mut left = parse_unary(cursor)?;
    loop {
        let before_op_pos = cursor.pos;
        skip_whitespace(cursor);
        let op = match try_read_binary_op(cursor)? {
            Some(op) => op,
            None => {
                cursor.pos = before_op_pos;
                return Ok(left);
            }
        };
        let prec = precedence_of(op);
        if prec < min_precedence {
            cursor.pos = before_op_pos;
            return Ok(left);
        }
        let right = parse_binary(cursor, prec + 1)?;
        let src = format!("{} {} {}", left.source(), op.as_str(), right.source());
        let line = left.line();
        let column = left.column();
        left = Expression::Binary {
            op,
            left: Box::new(left),
            right: Box::new(right),
            source: src,
            line,
            column,
        };
    }
}

fn parse_or(cursor: &mut Cursor) -> Result<Expression, InkerError> {
    parse_binary(cursor, 1)
}

/// Fallback for a source the restricted grammar could not parse: relax a
/// grammar-shape `ParseError` into a full-JS `Raw` node (evaluated by the Node
/// renderer in V8 — Edge parity, 62-2). Semantic guards (unknown helper,
/// proto-pollution) are preserved and still error at parse time.
fn raw_fallback(
    source: &str,
    line: u32,
    column: u32,
    strict_err: InkerError,
) -> Result<Expression, InkerError> {
    // Only RELAX pure grammar-shape rejections (`ParseError`: method calls,
    // ternary, arrow fns, arithmetic, arrays, unary minus, …) into a full-JS
    // `Raw` node. PRESERVE the semantic guards — unknown helper (`UnknownHelper`,
    // typo detection) and proto-pollution / reserved-shorthand (`InvalidExpression`)
    // keep erroring at parse time. A rich expression that CALLS a registered
    // helper (`filter(u => can(u))`) is a `ParseError` (method call) → `Raw`; the
    // Node renderer evaluates it in V8 with the helper in scope (62-2 Edge pivot).
    if strict_err.code != ErrorCode::ParseError {
        return Err(strict_err);
    }
    Ok(Expression::Raw {
        source: source.to_string(),
        line,
        column,
    })
}

/// Top-level entry. Parses an entire expression and asserts no trailing
/// content. Also returns the helper-callsite counter so the caller can fold it
/// into the parent AST's `helper_count`.
pub fn parse_expression(
    source: &str,
    line: u32,
    column: u32,
    options: &ParseExpressionOptions,
) -> Result<Expression, InkerError> {
    if source.is_empty() {
        let mut e = InkerError::new(
            ErrorCode::ParseError,
            format!("Empty expression at line {line}, column {column}"),
        )
        .with_pos(line, column);
        if let Some(t) = &options.template_path {
            e = e.with_template(t.clone());
        }
        return Err(e);
    }
    let strict: Result<Expression, InkerError> = (|| {
        let mut cursor = make_cursor(source, line, column, options);
        skip_whitespace(&mut cursor);
        let expr = parse_or(&mut cursor)?;
        skip_whitespace(&mut cursor);
        if cursor.pos < cursor.chars.len() {
            let tail: String = cursor.chars[cursor.pos..].iter().collect();
            let pos = cursor.pos;
            return Err(fail_parse(
                &cursor,
                format!("trailing content after expression: '{tail}'"),
                pos,
            ));
        }
        Ok(expr)
    })();
    strict.or_else(|e| raw_fallback(source, line, column, e))
}

/// Parse and ALSO return the helper-callsite count so it can be folded into
/// the parent `InkerAst`.
pub fn parse_expression_with_helper_count(
    source: &str,
    line: u32,
    column: u32,
    options: &ParseExpressionOptions,
    start_id: u32,
) -> Result<(Expression, u32), InkerError> {
    if source.is_empty() {
        return parse_expression(source, line, column, options).map(|e| (e, start_id));
    }
    let strict: Result<(Expression, u32), InkerError> = (|| {
        let mut cursor = make_cursor(source, line, column, options);
        cursor.next_helper_id = start_id;
        skip_whitespace(&mut cursor);
        let expr = parse_or(&mut cursor)?;
        skip_whitespace(&mut cursor);
        if cursor.pos < cursor.chars.len() {
            let tail: String = cursor.chars[cursor.pos..].iter().collect();
            let pos = cursor.pos;
            return Err(fail_parse(
                &cursor,
                format!("trailing content after expression: '{tail}'"),
                pos,
            ));
        }
        Ok((expr, cursor.next_helper_id))
    })();
    // A `Raw` fallback contains no helper calls, so the helper-id counter is
    // unchanged (stays `start_id`).
    strict.or_else(|e| raw_fallback(source, line, column, e).map(|expr| (expr, start_id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts_no_helpers() -> ParseExpressionOptions {
        ParseExpressionOptions::default()
    }

    fn opts_with(names: &[&str]) -> ParseExpressionOptions {
        let mut o = ParseExpressionOptions::default();
        for n in names {
            o.helpers.insert((*n).to_string());
        }
        o
    }

    #[test]
    fn literal_true() {
        let e = parse_expression("true", 1, 1, &opts_no_helpers()).unwrap();
        match e {
            Expression::Literal {
                value: LiteralValue::Bool(true),
                ..
            } => {}
            _ => panic!("expected true literal"),
        }
    }

    #[test]
    fn literal_string() {
        let e = parse_expression("'hi'", 1, 1, &opts_no_helpers()).unwrap();
        match e {
            Expression::Literal {
                value: LiteralValue::String(s),
                ..
            } => {
                assert_eq!(s, "hi");
            }
            _ => panic!("expected string"),
        }
    }

    #[test]
    fn literal_number_with_decimal() {
        let e = parse_expression("123.456", 1, 1, &opts_no_helpers()).unwrap();
        match e {
            Expression::Literal {
                value: LiteralValue::Number(n),
                ..
            } => {
                assert!((n - 123.456).abs() < 1e-12);
            }
            _ => panic!("expected number"),
        }
    }

    #[test]
    fn path_simple() {
        let e = parse_expression("foo.bar", 1, 1, &opts_no_helpers()).unwrap();
        match e {
            Expression::Path { path, .. } => {
                assert_eq!(path.len(), 2);
            }
            _ => panic!("expected path"),
        }
    }

    #[test]
    fn call_with_helper_registered() {
        let opts = opts_with(&["upper"]);
        let e = parse_expression("upper('a')", 1, 1, &opts).unwrap();
        match e {
            Expression::Call { name, args, id, .. } => {
                assert_eq!(name, "upper");
                assert_eq!(args.len(), 1);
                assert_eq!(id, 0);
            }
            _ => panic!("expected call"),
        }
    }

    #[test]
    fn call_unknown_helper_errors() {
        let e = parse_expression("upper('a')", 1, 1, &opts_no_helpers()).unwrap_err();
        assert_eq!(e.code, ErrorCode::UnknownHelper);
    }

    #[test]
    fn object_literal_with_shorthand() {
        let e = parse_expression("{ id: 42, name }", 1, 1, &opts_no_helpers()).unwrap();
        match e {
            Expression::Object { entries, .. } => {
                assert_eq!(entries.len(), 2);
                assert_eq!(entries[0].key, "id");
                assert!(!entries[0].shorthand);
                assert_eq!(entries[1].key, "name");
                assert!(entries[1].shorthand);
            }
            _ => panic!("expected object"),
        }
    }

    #[test]
    fn object_shorthand_reserved_rejected() {
        let e = parse_expression("{ true }", 1, 1, &opts_no_helpers()).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidExpression);
    }

    #[test]
    fn object_proto_pollution_rejected() {
        let e = parse_expression("{ __proto__: 1 }", 1, 1, &opts_no_helpers()).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidExpression);
    }

    #[test]
    fn binary_and_precedence_eq_higher_than_and() {
        // `a == 1 && b == 2` should parse as `(a == 1) && (b == 2)`.
        let e = parse_expression("a == 1 && b == 2", 1, 1, &opts_no_helpers()).unwrap();
        match e {
            Expression::Binary {
                op: BinaryOp::And, ..
            } => {}
            _ => panic!("expected outer And"),
        }
    }

    #[test]
    fn unary_not() {
        let e = parse_expression("!active", 1, 1, &opts_no_helpers()).unwrap();
        match e {
            Expression::Unary {
                op: UnaryOp::Not, ..
            } => {}
            _ => panic!("expected unary"),
        }
    }

    #[test]
    fn deep_unary_chain_is_bounded_not_stack_overflow() {
        // A long `!` chain must not overflow the native stack (which would abort
        // the process across the NAPI boundary). The strict parser still hits its
        // depth guard (a ParseError) BEFORE recursing to overflow; that grammar
        // rejection then falls back to a full-JS `Raw` node evaluated by the VM
        // (which has its own bounded stack). The invariant preserved here is
        // "no native stack overflow", not the specific error.
        let src = format!("{}x", "!".repeat(MAX_EXPRESSION_DEPTH as usize + 50));
        let e = parse_expression(&src, 1, 1, &opts_no_helpers()).unwrap();
        assert!(matches!(e, Expression::Raw { .. }));
    }

    #[test]
    fn group_grouping() {
        let e = parse_expression("(a && b)", 1, 1, &opts_no_helpers()).unwrap();
        match e {
            Expression::Group { .. } => {}
            _ => panic!("expected group"),
        }
    }

    #[test]
    fn unary_minus_is_full_js_raw() {
        // `-foo` (numeric negation) is valid JS the restricted grammar rejected;
        // it now falls back to a `Raw` node evaluated by the VM (Edge parity).
        let e = parse_expression("-foo", 1, 1, &opts_no_helpers()).unwrap();
        assert!(matches!(e, Expression::Raw { .. }));
    }

    #[test]
    fn array_literal_is_full_js_raw() {
        // Array literals in expression position are valid JS (Edge parity); the
        // restricted grammar rejected them, they now fall back to a `Raw` node.
        let e = parse_expression("[1, 2]", 1, 1, &opts_no_helpers()).unwrap();
        assert!(matches!(e, Expression::Raw { .. }));
    }

    #[test]
    fn helper_id_assigns_inner_first_for_pre_resolve_correctness() {
        // ADR-007 pre-resolve evaluates helper call sites in array order. Inner
        // calls MUST resolve before outer ones so the outer's `evalArg` can
        // consume the already-resolved inner value via id lookup. Assignment
        // happens AFTER parse_call_args returns, so inner=0, outer=1 — the
        // reverse would break nested-helper rendering.
        let opts = opts_with(&["a", "b"]);
        let e = parse_expression("a(b())", 1, 1, &opts).unwrap();
        match e {
            Expression::Call {
                id: outer_id, args, ..
            } => {
                assert_eq!(outer_id, 1, "outer call assigned AFTER inner resolves");
                match &args[0] {
                    Expression::Call { id, .. } => {
                        assert_eq!(*id, 0, "inner call assigned first (pre-resolve order)");
                    }
                    _ => panic!("expected inner call"),
                }
            }
            _ => panic!("expected call"),
        }
    }

    #[test]
    fn collect_call_sites_visits_nested() {
        let opts = opts_with(&["a", "b"]);
        let e = parse_expression("a(b())", 1, 1, &opts).unwrap();
        let mut sites: Vec<&Expression> = Vec::new();
        e.collect_call_sites(&mut sites);
        assert_eq!(sites.len(), 2);
    }
}
