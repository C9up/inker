//! Renderer — mirrors `packages/inker/src/render.ts` semantics.
//!
//! Walks an `InkerAst` against a `serde_json::Value` data tree and emits the
//! final HTML string.
//!
//! ## Helper resolution (ADR-007, as adapted for 55.1)
//!
//! Helpers are JS functions; their arguments may depend on render-time scope
//! (loop bindings, conditional branches). The original ADR-007 "flat dict by
//! id" model cannot reproduce this (a helper inside an `each` produces N values,
//! one per iteration). Instead:
//!
//!   1. `collect::collect_invocations` walks the control flow with the data and
//!      emits an ORDERED tape of `{id, name, args}` at every helper position,
//!      respecting conditionals (only the taken branch) and loops (one entry per
//!      iteration). Args are evaluated in-scope; nested-call / operator-combined
//!      / control-flow-position helpers are NOT supported (clean error — 55.1
//!      limitation, see AC16). Behaviour is covered by this crate's own
//!      `#[cfg(test)]` suite (parity with the pre-migration TS engine).
//!   2. TS invokes each tape entry's helper (the only JS-side step) producing an
//!      ordered `Vec<ResolvedHelperValue>`.
//!   3. `render` re-walks the SAME control flow, consuming the resolved tape via
//!      a cursor at every helper position. No V8 callback, no ThreadsafeFunction.
//!
//! Restricted helper contract (covers every existing test): helpers may appear
//! only as (a) the entire interpolation expression `{{ helper(args) }}` or
//! (b) a component-arg value `{ key: helper(args) }`. Args are literals, paths,
//! or objects of literals/paths.
//!
//! Known 55.1 divergences from the pre-migration TS engine (intentional):
//!   - A helper used as a component-arg value (case b) that returns a
//!     `SafeString` loses its safe-ness: the resolved value is stored into the
//!     component scope as a plain JSON string and is HTML-escaped again when the
//!     component body interpolates it. The `serde_json::Value` scope carries no
//!     safe-string marker. Wrap raw HTML inside the component instead.
//!   - `each` over a non-plain object (Date, RegExp, class instance) no longer
//!     gets the old "expected plain object" diagnostic: such values are first
//!     serialised by napi-rs (Date → string, instance → own-key object) and then
//!     iterated/rendered per their serialised shape.
//!
//! ## Map / Set encoding contract
//!
//! JS `Map` / `Set` cannot cross NAPI as themselves. The TS side pre-encodes
//! `Map<K,V>` → `Array<[K,V]>` and `Set<V>` → `Array<V>` (flat values, matching
//! `Array.from(set)`). Output stays byte-identical: destructured `as [k, v]`
//! iteration over a Map's 2-tuples reproduces `Map.entries()`, and single-binding
//! `as item` iteration over a Set's values reproduces `Set` iteration order.

use crate::ast::{EachBinding, InkerNode, LayoutNode, PartialNode, SlotNode};
use crate::error::{ErrorCode, InkerError};
use crate::identifiers::is_prototype_pollution_key;
use crate::parse::InkerAst;
use crate::parse_expression::{BinaryOp, Expression, LiteralValue};
use crate::resolve_path::{resolve_path, ResolvePathContext};
use serde_json::{Map as JsonMap, Value};
use std::collections::HashMap;

const MAX_RENDER_DEPTH: u32 = 100;

#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedHelperValue {
	/// Helper returned a regular string — escape per the interpolation kind.
	Plain(String),
	/// Helper returned a `SafeString` — pass through verbatim (raw HTML).
	Safe(String),
}

impl ResolvedHelperValue {
	fn value(&self) -> &str {
		match self {
			ResolvedHelperValue::Plain(s) | ResolvedHelperValue::Safe(s) => s,
		}
	}
}

#[derive(Debug, Default, Clone)]
pub struct RenderContext {
	pub template_path: Option<String>,
	pub template_name: Option<String>,
	pub partials: HashMap<String, InkerAst>,
	pub components: HashMap<String, InkerAst>,
	pub body_html: Option<String>,
}

/// Render an AST consuming the pre-resolved helper tape in walk order.
pub fn render(
	ast: &InkerAst,
	data: &Value,
	context: &RenderContext,
	tape: &[ResolvedHelperValue],
) -> Result<String, InkerError> {
	let mut buf = String::new();
	let mut cursor = 0usize;
	render_nodes(&ast.nodes, data, context, &mut buf, 0, tape, &mut cursor)?;
	Ok(buf)
}

fn next_tape<'a>(
	tape: &'a [ResolvedHelperValue],
	cursor: &mut usize,
	context: &RenderContext,
) -> Result<&'a ResolvedHelperValue, InkerError> {
	let entry = tape.get(*cursor).ok_or_else(|| {
		make_err(
			ErrorCode::InvalidExpression,
			"Helper tape underflow — collect_invocations and render disagree on helper-execution order (internal invariant violation)",
			0,
			0,
			context,
		)
	})?;
	*cursor += 1;
	Ok(entry)
}

#[allow(clippy::too_many_arguments)]
fn render_nodes(
	nodes: &[InkerNode],
	data: &Value,
	context: &RenderContext,
	buf: &mut String,
	depth: u32,
	tape: &[ResolvedHelperValue],
	cursor: &mut usize,
) -> Result<(), InkerError> {
	if depth > MAX_RENDER_DEPTH {
		return Err(make_err(
			ErrorCode::InvalidExpression,
			format!(
				"Render recursion exceeded maximum depth {MAX_RENDER_DEPTH} — likely cause: a partial/component chain or data-recursive 'each' that does not terminate"
			),
			0,
			0,
			context,
		));
	}
	for node in nodes {
		render_node(node, data, context, buf, depth, tape, cursor)?;
	}
	Ok(())
}

#[allow(clippy::too_many_arguments)]
fn render_node(
	node: &InkerNode,
	data: &Value,
	context: &RenderContext,
	buf: &mut String,
	depth: u32,
	tape: &[ResolvedHelperValue],
	cursor: &mut usize,
) -> Result<(), InkerError> {
	match node {
		InkerNode::Text { value } => {
			buf.push_str(value);
		}
		InkerNode::Interpolation {
			expression,
			escape,
			source,
			line,
			column,
		} => {
			if matches!(expression, Expression::Call { .. }) {
				let entry = next_tape(tape, cursor, context)?;
				match entry {
					ResolvedHelperValue::Safe(s) => buf.push_str(s),
					ResolvedHelperValue::Plain(s) => {
						if *escape {
							buf.push_str(&crate::escape::escape_text(s));
						} else {
							buf.push_str(s);
						}
					}
				}
			} else {
				let v = eval_pure(expression, data, context)?;
				if v.is_null() {
					// null/undefined render as empty
				} else if *escape {
					buf.push_str(&escape_html(&v, source, *line, *column, context)?);
				} else {
					buf.push_str(&safe_stringify(&v, source, *line, *column, context)?);
				}
			}
		}
		InkerNode::Slot(SlotNode { name, line, column }) => {
			if name != "body" {
				return Err(make_err(
					ErrorCode::UnknownSlot,
					format!("Unknown slot '{name}' — Inker only supports {{{{> body }}}} as of 53.4."),
					*line,
					*column,
					context,
				));
			}
			if let Some(body) = &context.body_html {
				buf.push_str(body);
			}
		}
		InkerNode::Partial(PartialNode { name, line, column, .. }) => {
			let key = normalize_partial_key(name);
			let partial_ast = context.partials.get(&key).ok_or_else(|| {
				make_err(
					ErrorCode::DiskRequired,
					format!(
						"render cannot resolve {{% include '{name}' %}} — partial not pre-loaded into context.partials"
					),
					*line,
					*column,
					context,
				)
			})?;
			let mut sub_ctx = context.clone();
			sub_ctx.template_name = Some(name.clone());
			render_nodes(&partial_ast.nodes, data, &sub_ctx, buf, depth + 1, tape, cursor)?;
		}
		InkerNode::Layout(LayoutNode { name, line, column, .. }) => {
			return Err(make_err(
				ErrorCode::DiskRequired,
				format!(
					"render cannot resolve {{% layout '{name}' %}} — LayoutNode must be stripped by the composer before render"
				),
				*line,
				*column,
				context,
			));
		}
		InkerNode::If {
			condition,
			then_nodes,
			else_nodes,
			..
		} => {
			let cond_val = eval_pure(&condition.expression, data, context)?;
			if json_truthy(&cond_val) {
				render_nodes(then_nodes, data, context, buf, depth + 1, tape, cursor)?;
			} else if let Some(els) = else_nodes {
				render_nodes(els, data, context, buf, depth + 1, tape, cursor)?;
			}
		}
		InkerNode::Each { .. } => {
			render_each(node, data, context, buf, depth + 1, tape, cursor)?;
		}
		InkerNode::Component(c) => {
			let key = normalize_partial_key(&c.name);
			let component_ast = context.components.get(&key).ok_or_else(|| {
				make_err(
					ErrorCode::DiskRequired,
					format!(
						"render cannot resolve {{% component '{}' %}} — component not pre-loaded into context.components",
						c.name
					),
					c.line,
					c.column,
					context,
				)
			})?;
			// Args first (tape order), then body — must mirror collect.
			let mut scoped = JsonMap::new();
			for arg in &c.args {
				let v = if matches!(arg.value, Expression::Call { .. }) {
					let entry = next_tape(tape, cursor, context)?;
					Value::String(entry.value().to_string())
				} else {
					eval_pure(&arg.value, data, context)?
				};
				scoped.insert(arg.key.clone(), v);
			}
			let scoped_data = Value::Object(scoped);
			let mut sub_ctx = context.clone();
			sub_ctx.template_name = Some(c.name.clone());
			sub_ctx.body_html = None;
			render_nodes(
				&component_ast.nodes,
				&scoped_data,
				&sub_ctx,
				buf,
				depth + 1,
				tape,
				cursor,
			)?;
		}
	}
	Ok(())
}

#[allow(clippy::too_many_arguments)]
fn render_each(
	node: &InkerNode,
	data: &Value,
	context: &RenderContext,
	buf: &mut String,
	depth: u32,
	tape: &[ResolvedHelperValue],
	cursor: &mut usize,
) -> Result<(), InkerError> {
	let (iterable_expr, iterable_source, binding, body_nodes, else_nodes, line, column) =
		match node {
			InkerNode::Each {
				iterable,
				iterable_source,
				binding,
				body_nodes,
				else_nodes,
				line,
				column,
			} => (
				iterable,
				iterable_source,
				binding,
				body_nodes,
				else_nodes,
				*line,
				*column,
			),
			_ => unreachable!("render_each called on non-Each node"),
		};

	let iterable = eval_pure(iterable_expr, data, context)?;

	match binding {
		EachBinding::Single(name) => {
			let arr = match &iterable {
				Value::Array(a) => a,
				other => {
					let type_label = type_of_iterable(other);
					let hint = match other {
						Value::Null => format!(" — did you forget '{{% if {iterable_source} %}}' wrapper?"),
						_ => " (single-binding 'as item' only accepts Array; use 'as [k, v]' for Map/Set/object)".to_string(),
					};
					return Err(fail_invalid_iterable(
						iterable_source,
						binding,
						line,
						column,
						format!("expected an Array; got {type_label}{hint}"),
						context,
					));
				}
			};
			if arr.is_empty() {
				if let Some(els) = else_nodes {
					render_nodes(els, data, context, buf, depth, tape, cursor)?;
				}
				return Ok(());
			}
			for item in arr {
				let scoped = merge_scope(data, name, item);
				render_nodes(body_nodes, &scoped, context, buf, depth, tape, cursor)?;
			}
			Ok(())
		}
		EachBinding::Destructured([k_name, v_name]) => {
			if iterable.is_null() {
				return Err(fail_invalid_iterable(
					iterable_source,
					binding,
					line,
					column,
					format!(
						"expected Array | Map | Set | object; got null — did you forget '{{% if {iterable_source} %}}' wrapper?"
					),
					context,
				));
			}
			match &iterable {
				Value::Array(arr) => {
					if arr.is_empty() {
						if let Some(els) = else_nodes {
							render_nodes(els, data, context, buf, depth, tape, cursor)?;
						}
						return Ok(());
					}
					for (i, elem) in arr.iter().enumerate() {
						let pair = match elem {
							Value::Array(a) if a.len() == 2 => a,
							other => {
								return Err(fail_invalid_iterable(
									iterable_source,
									binding,
									line,
									column,
									format!(
										"destructured binding expects each element to be a 2-tuple; got {} at index {i}",
										type_of_iterable(other)
									),
									context,
								));
							}
						};
						let scoped =
							merge_scope_pair(data, k_name, &pair[0], v_name, &pair[1]);
						render_nodes(body_nodes, &scoped, context, buf, depth, tape, cursor)?;
					}
					Ok(())
				}
				Value::Object(obj) => {
					if obj.is_empty() {
						if let Some(els) = else_nodes {
							render_nodes(els, data, context, buf, depth, tape, cursor)?;
						}
						return Ok(());
					}
					for (k, v) in obj {
						if is_prototype_pollution_key(k) {
							continue;
						}
						let scoped =
							merge_scope_pair(data, k_name, &Value::String(k.clone()), v_name, v);
						render_nodes(body_nodes, &scoped, context, buf, depth, tape, cursor)?;
					}
					Ok(())
				}
				other => Err(fail_invalid_iterable(
					iterable_source,
					binding,
					line,
					column,
					format!(
						"destructured binding requires Array | Map | Set | object; got {}",
						type_of_iterable(other)
					),
					context,
				)),
			}
		}
	}
}

// ---- pure expression evaluation (helper-free) ----

/// Evaluate an expression to a concrete JSON value WITHOUT invoking helpers.
/// Used for paths / literals / objects / unary / binary / group in
/// control-flow-determining and data positions. A `Call` expression is a
/// 55.1-unsupported position here (helpers are resolved via the tape only at
/// interpolation / component-arg positions) and produces a clean error.
pub fn eval_pure(
	expr: &Expression,
	data: &Value,
	context: &RenderContext,
) -> Result<Value, InkerError> {
	match expr {
		Expression::Literal { value, .. } => Ok(literal_to_json(value)),
		Expression::Path { path, line, column, source } => {
			let ctx = ResolvePathContext {
				template_path: context.template_path.clone(),
				template_name: context.template_name.clone(),
				line: Some(*line),
				column: Some(*column),
				expression: Some(source.clone()),
			};
			resolve_path(data, path, &ctx)
		}
		Expression::Group { expression, .. } => eval_pure(expression, data, context),
		Expression::Unary { operand, .. } => {
			let v = eval_pure(operand, data, context)?;
			Ok(Value::Bool(!json_truthy(&v)))
		}
		Expression::Binary {
			op,
			left,
			right,
			line,
			column,
			source,
		} => {
			let lv = eval_pure(left, data, context)?;
			if *op == BinaryOp::And {
				return if !json_truthy(&lv) { Ok(lv) } else { eval_pure(right, data, context) };
			}
			if *op == BinaryOp::Or {
				return if json_truthy(&lv) { Ok(lv) } else { eval_pure(right, data, context) };
			}
			let rv = eval_pure(right, data, context)?;
			let cmp = compare_binary(*op, &lv, &rv, *line, *column, source, context)?;
			Ok(Value::Bool(cmp))
		}
		Expression::Object { entries, .. } => {
			let mut obj = JsonMap::new();
			for entry in entries {
				obj.insert(entry.key.clone(), eval_pure(&entry.value, data, context)?);
			}
			Ok(Value::Object(obj))
		}
		Expression::Call { name, line, column, source, .. } => Err(make_err(
			ErrorCode::InvalidExpression,
			format!(
				"Helper call '{name}' is only supported as a full interpolation `{{{{ {name}(...) }}}}` or a component-arg value in the Rust engine (55.1) — not inside conditions, iterables, operators, or as a nested argument"
			),
			*line,
			*column,
			context,
		).with_expr(source)),
	}
}

fn literal_to_json(v: &LiteralValue) -> Value {
	match v {
		LiteralValue::String(s) => Value::String(s.clone()),
		LiteralValue::Number(n) => serde_json::Number::from_f64(*n)
			.map(Value::Number)
			.unwrap_or(Value::Null),
		LiteralValue::Bool(b) => Value::Bool(*b),
		LiteralValue::Null | LiteralValue::Undefined => Value::Null,
	}
}

fn json_truthy(v: &Value) -> bool {
	match v {
		Value::Null => false,
		Value::Bool(b) => *b,
		Value::Number(n) => match n.as_f64() {
			Some(f) => f != 0.0 && !f.is_nan(),
			None => true,
		},
		Value::String(s) => !s.is_empty(),
		Value::Array(_) | Value::Object(_) => true,
	}
}

// ---- comparison ----

fn loose_eq(a: &Value, b: &Value) -> bool {
	if discriminant_of(a) == discriminant_of(b) {
		return strict_eq(a, b);
	}
	// JS Abstract Equality: null/undefined are loosely-equal only to each other
	// (the same-type case above), never to any other type — so a null on exactly
	// one side is always unequal, no numeric coercion.
	if a.is_null() || b.is_null() {
		return false;
	}
	// number / string / boolean coerce to number and compare. Array/Object
	// ToPrimitive coercion (e.g. `[] == 0`) is intentionally NOT reproduced —
	// templates do not compare collections with `==`; such a comparison is unequal.
	match (a, b) {
		(Value::Array(_), _)
		| (_, Value::Array(_))
		| (Value::Object(_), _)
		| (_, Value::Object(_)) => false,
		_ => match (number_of(a), number_of(b)) {
			(Some(x), Some(y)) => x == y,
			_ => false,
		},
	}
}

fn strict_eq(a: &Value, b: &Value) -> bool {
	match (a, b) {
		(Value::Null, Value::Null) => true,
		(Value::Bool(x), Value::Bool(y)) => x == y,
		(Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
		(Value::String(x), Value::String(y)) => x == y,
		(Value::Array(x), Value::Array(y)) => x == y,
		(Value::Object(x), Value::Object(y)) => x == y,
		_ => false,
	}
}

fn discriminant_of(v: &Value) -> u8 {
	match v {
		Value::Null => 0,
		Value::Bool(_) => 1,
		Value::Number(_) => 2,
		Value::String(_) => 3,
		Value::Array(_) => 4,
		Value::Object(_) => 5,
	}
}

fn number_of(v: &Value) -> Option<f64> {
	match v {
		Value::Number(n) => n.as_f64(),
		// JS `Number(s)`: a blank/whitespace-only string is 0, leading/trailing
		// whitespace is ignored, an unparseable string is NaN (None here).
		Value::String(s) => {
			let t = s.trim();
			if t.is_empty() {
				Some(0.0)
			} else {
				t.parse::<f64>().ok()
			}
		}
		Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
		Value::Null => Some(0.0),
		_ => None,
	}
}

#[allow(clippy::too_many_arguments)]
fn compare_binary(
	op: BinaryOp,
	left: &Value,
	right: &Value,
	line: u32,
	column: u32,
	source: &str,
	context: &RenderContext,
) -> Result<bool, InkerError> {
	match op {
		BinaryOp::Eq => Ok(loose_eq(left, right)),
		BinaryOp::NotEq => Ok(!loose_eq(left, right)),
		BinaryOp::StrictEq => Ok(strict_eq(left, right)),
		BinaryOp::StrictNotEq => Ok(!strict_eq(left, right)),
		BinaryOp::Lt | BinaryOp::Lte | BinaryOp::Gt | BinaryOp::Gte => {
			relational_compare(op, left, right, line, column, source, context)
		}
		BinaryOp::And | BinaryOp::Or => unreachable!("short-circuited in eval_pure"),
	}
}

#[allow(clippy::too_many_arguments)]
fn relational_compare(
	op: BinaryOp,
	left: &Value,
	right: &Value,
	line: u32,
	column: u32,
	source: &str,
	context: &RenderContext,
) -> Result<bool, InkerError> {
	if let (Value::Number(a), Value::Number(b)) = (left, right) {
		return Ok(apply_rel(op, a.as_f64().unwrap_or(0.0), b.as_f64().unwrap_or(0.0)));
	}
	if let (Value::String(a), Value::String(b)) = (left, right) {
		return Ok(apply_rel_str(op, a, b));
	}
	Err(make_err(
		ErrorCode::InvalidExpression,
		format!(
			"Cannot apply '{}' to {} and {} at line {line}, column {column} — relational operators require both operands to be number/bigint or both string",
			op.as_str(),
			js_typeof(left),
			js_typeof(right)
		),
		line,
		column,
		context,
	)
	.with_expr(source))
}

fn apply_rel(op: BinaryOp, a: f64, b: f64) -> bool {
	match op {
		BinaryOp::Lt => a < b,
		BinaryOp::Lte => a <= b,
		BinaryOp::Gt => a > b,
		BinaryOp::Gte => a >= b,
		_ => unreachable!(),
	}
}

fn apply_rel_str(op: BinaryOp, a: &str, b: &str) -> bool {
	match op {
		BinaryOp::Lt => a < b,
		BinaryOp::Lte => a <= b,
		BinaryOp::Gt => a > b,
		BinaryOp::Gte => a >= b,
		_ => unreachable!(),
	}
}

fn js_typeof(v: &Value) -> &'static str {
	match v {
		Value::Null => "object",
		Value::Bool(_) => "boolean",
		Value::Number(_) => "number",
		Value::String(_) => "string",
		Value::Array(_) | Value::Object(_) => "object",
	}
}

// ---- stringify / escape ----

// Match JavaScript `String(n)`: integer-valued floats render without a trailing
// `.0` and `-0` renders as `0`. serde_json stores integers (i64/u64) and floats
// (f64) distinctly — integer storage already matches JS, so only the f64 case
// needs adjustment. (The full ECMAScript `Number::toString` exponent thresholds
// for |x| ≥ 1e21 / < 1e-6 are not reproduced; such magnitudes do not occur in
// template literals or HTML view data.)
fn js_number_to_string(n: &serde_json::Number) -> String {
	if n.is_f64() {
		if let Some(f) = n.as_f64() {
			if f == 0.0 {
				return "0".to_string();
			}
			if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 {
				return format!("{f:.0}");
			}
		}
	}
	n.to_string()
}

fn safe_stringify(
	value: &Value,
	source: &str,
	line: u32,
	column: u32,
	context: &RenderContext,
) -> Result<String, InkerError> {
	match value {
		Value::String(s) => Ok(s.clone()),
		Value::Number(n) => Ok(js_number_to_string(n)),
		Value::Bool(b) => Ok(b.to_string()),
		Value::Null => Ok(String::new()),
		_ => {
			let kind = match value {
				Value::Array(_) => "Array",
				Value::Object(_) => "Object",
				_ => "unknown",
			};
			Err(make_err(
				ErrorCode::InvalidExpression,
				format!(
					"Cannot stringify {kind} value for '{source}' at line {line}, column {column} — use a specific field path (e.g. {{{{ {source}.fieldName }}}}) or register a helper that returns a string"
				),
				line,
				column,
				context,
			)
			.with_expr(source))
		}
	}
}

fn escape_html(
	value: &Value,
	source: &str,
	line: u32,
	column: u32,
	context: &RenderContext,
) -> Result<String, InkerError> {
	let s = safe_stringify(value, source, line, column, context)?;
	Ok(crate::escape::escape_text(&s))
}

// ---- partial key / scope helpers ----

pub(crate) fn normalize_partial_key(name: &str) -> String {
	let mut key = name.to_string();
	while key.starts_with("./") {
		key = key.strip_prefix("./").unwrap_or(&key).to_string();
	}
	while key.contains("//") {
		key = key.replace("//", "/");
	}
	while key.contains("/./") {
		key = key.replace("/./", "/");
	}
	if key.ends_with('/') {
		key.pop();
	}
	key
}

fn merge_scope(data: &Value, binding_name: &str, value: &Value) -> Value {
	let mut obj = match data {
		Value::Object(o) => o.clone(),
		_ => JsonMap::new(),
	};
	obj.insert(binding_name.to_string(), value.clone());
	Value::Object(obj)
}

fn merge_scope_pair(
	data: &Value,
	k_name: &str,
	k: &Value,
	v_name: &str,
	v: &Value,
) -> Value {
	let mut obj = match data {
		Value::Object(o) => o.clone(),
		_ => JsonMap::new(),
	};
	obj.insert(k_name.to_string(), k.clone());
	obj.insert(v_name.to_string(), v.clone());
	Value::Object(obj)
}

// ---- each iteration diagnostics ----

fn binding_preview(b: &EachBinding) -> String {
	match b {
		EachBinding::Single(name) => name.clone(),
		EachBinding::Destructured([a, b]) => format!("[{a}, {b}]"),
	}
}

fn type_of_iterable(v: &Value) -> &'static str {
	match v {
		Value::Null => "null",
		Value::Bool(_) => "boolean",
		Value::Number(_) => "number",
		Value::String(_) => "string",
		Value::Array(_) => "Array",
		Value::Object(_) => "object",
	}
}

fn fail_invalid_iterable(
	iterable_source: &str,
	binding: &EachBinding,
	line: u32,
	column: u32,
	reason: String,
	context: &RenderContext,
) -> InkerError {
	make_err(
		ErrorCode::InvalidIterable,
		format!(
			"{{% each {iterable_source} as {} %}} {reason} at line {line}, column {column}",
			binding_preview(binding)
		),
		line,
		column,
		context,
	)
	.with_expr(iterable_source)
}

fn make_err(
	code: ErrorCode,
	message: impl Into<String>,
	line: u32,
	column: u32,
	context: &RenderContext,
) -> InkerError {
	let mut e = InkerError::new(code, message);
	if line != 0 || column != 0 {
		e = e.with_pos(line, column);
	}
	if let Some(t) = &context.template_path {
		e = e.with_template(t.clone());
	} else if let Some(t) = &context.template_name {
		e = e.with_template(t.clone());
	}
	e
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::lex::{lex, LexOptions};
	use crate::parse::{parse, ParseOptions};
	use serde_json::json;
	use std::collections::HashSet;

	fn parse_template(s: &str) -> InkerAst {
		let toks = lex(s, &LexOptions::default()).expect("lex");
		parse(&toks, &ParseOptions::default()).expect("parse")
	}

	fn parse_with_helpers(s: &str, helpers: &[&str]) -> InkerAst {
		let toks = lex(s, &LexOptions::default()).expect("lex");
		let mut h: HashSet<String> = HashSet::new();
		for n in helpers {
			h.insert((*n).to_string());
		}
		parse(&toks, &ParseOptions { template_path: None, helpers: h }).expect("parse")
	}

	fn render_no_helpers(ast: &InkerAst, data: &Value) -> Result<String, InkerError> {
		render(ast, data, &RenderContext::default(), &[])
	}

	#[test]
	fn pure_text_renders() {
		let ast = parse_template("hello world");
		assert_eq!(render_no_helpers(&ast, &json!({})).unwrap(), "hello world");
	}

	#[test]
	fn interpolation_escapes() {
		let ast = parse_template("hi {{ name }}");
		assert_eq!(
			render_no_helpers(&ast, &json!({ "name": "<bold>" })).unwrap(),
			"hi &lt;bold&gt;"
		);
	}

	#[test]
	fn raw_interpolation_no_escape() {
		let ast = parse_template("{{{ html }}}");
		assert_eq!(
			render_no_helpers(&ast, &json!({ "html": "<em>x</em>" })).unwrap(),
			"<em>x</em>"
		);
	}

	#[test]
	fn null_value_renders_empty() {
		let ast = parse_template("a{{ x }}b");
		assert_eq!(render_no_helpers(&ast, &json!({ "x": null })).unwrap(), "ab");
	}

	#[test]
	fn if_truthy_then() {
		let ast = parse_template("{% if active %}YES{% else %}NO{% endif %}");
		assert_eq!(render_no_helpers(&ast, &json!({ "active": true })).unwrap(), "YES");
	}

	#[test]
	fn each_single_binding() {
		let ast = parse_template("{% each items as i %}[{{ i }}]{% endeach %}");
		assert_eq!(
			render_no_helpers(&ast, &json!({ "items": ["a", "b"] })).unwrap(),
			"[a][b]"
		);
	}

	#[test]
	fn each_destructured_array_of_pairs() {
		let ast = parse_template("{% each m as [k, v] %}{{ k }}={{ v }};{% endeach %}");
		assert_eq!(
			render_no_helpers(&ast, &json!({ "m": [["a", "1"], ["b", "2"]] })).unwrap(),
			"a=1;b=2;"
		);
	}

	#[test]
	fn helper_interp_consumes_tape_plain_escaped() {
		let ast = parse_with_helpers("{{ up(name) }}", &["up"]);
		let tape = vec![ResolvedHelperValue::Plain("<X>".to_string())];
		let out = render(&ast, &json!({ "name": "x" }), &RenderContext::default(), &tape).unwrap();
		assert_eq!(out, "&lt;X&gt;");
	}

	#[test]
	fn helper_interp_safe_string_raw() {
		let ast = parse_with_helpers("{{ t('k') }}", &["t"]);
		let tape = vec![ResolvedHelperValue::Safe("<b>x</b>".to_string())];
		let out = render(&ast, &json!({}), &RenderContext::default(), &tape).unwrap();
		assert_eq!(out, "<b>x</b>");
	}

	#[test]
	fn helper_in_condition_is_unsupported_error() {
		let ast = parse_with_helpers("{% if isOn() %}Y{% endif %}", &["isOn"]);
		let e = render(&ast, &json!({}), &RenderContext::default(), &[]).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}

	#[test]
	fn unknown_identifier_errors() {
		let ast = parse_template("{{ missing }}");
		let e = render_no_helpers(&ast, &json!({})).unwrap_err();
		assert_eq!(e.code, ErrorCode::UnknownIdentifier);
	}

	#[test]
	fn integer_literal_renders_without_trailing_zero() {
		// JS String(100) === "100", not "100.0".
		let ast = parse_template("{{ 100 }}");
		assert_eq!(render_no_helpers(&ast, &json!({})).unwrap(), "100");
	}

	#[test]
	fn integer_valued_data_number_renders_without_trailing_zero() {
		let ast = parse_template("{{ x }}");
		assert_eq!(render_no_helpers(&ast, &json!({ "x": 100.0 })).unwrap(), "100");
	}

	#[test]
	fn fractional_number_renders_with_decimal() {
		let ast = parse_template("{{ x }}");
		assert_eq!(render_no_helpers(&ast, &json!({ "x": 100.5 })).unwrap(), "100.5");
	}

	#[test]
	fn loose_eq_null_is_not_equal_to_zero() {
		// JS: null == 0 is false (null/undefined loose-eq only each other).
		let ast = parse_template("{% if x == 0 %}Y{% else %}N{% endif %}");
		assert_eq!(render_no_helpers(&ast, &json!({ "x": null })).unwrap(), "N");
	}

	#[test]
	fn loose_eq_empty_string_equals_zero() {
		// JS: "" == 0 is true (Number("") === 0).
		let ast = parse_template("{% if x == 0 %}Y{% else %}N{% endif %}");
		assert_eq!(render_no_helpers(&ast, &json!({ "x": "" })).unwrap(), "Y");
	}

	#[test]
	fn loose_eq_numeric_string_equals_number() {
		let ast = parse_template("{% if x == 5 %}Y{% else %}N{% endif %}");
		assert_eq!(render_no_helpers(&ast, &json!({ "x": "5" })).unwrap(), "Y");
	}

	#[test]
	fn each_over_object_skips_prototype_pollution_keys() {
		let ast = parse_template("{% each obj as [k, v] %}{{ k }}={{ v }};{% endeach %}");
		let data = json!({ "obj": { "a": "1", "__proto__": "bad", "constructor": "bad" } });
		assert_eq!(render_no_helpers(&ast, &data).unwrap(), "a=1;");
	}
}
