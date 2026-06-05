//! Helper-invocation collection pass (ADR-007, as adapted for 55.1).
//!
//! Walks the control flow of an `InkerAst` against the runtime data tree in
//! EXACTLY the same order as `render::render`, and emits an ordered tape of
//! `Invocation { id, name, args }` at every helper position. Conditionals only
//! descend the taken branch; loops emit one entry per iteration with the
//! loop-scoped data. The TS side then invokes each entry's helper (the sole
//! JS-side step) and `render` consumes the resolved results via a cursor in the
//! identical walk order.
//!
//! Helpers are supported ONLY as (a) the whole interpolation expression
//! `{{ helper(args) }}` or (b) a component-arg value `{ key: helper(args) }`.
//! Args are evaluated in-scope via `render::eval_pure` (helper-free): literals,
//! paths, objects of literals/paths. Nested-call / operator-combined /
//! control-flow-position helpers produce a clean error (55.1 limitation).

use crate::ast::{EachBinding, InkerNode};
use crate::error::{ErrorCode, InkerError};
use crate::identifiers::is_prototype_pollution_key;
use crate::parse::InkerAst;
use crate::parse_expression::Expression;
use crate::render::{eval_pure, normalize_partial_key, RenderContext};
use serde_json::{Map as JsonMap, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct Invocation {
	pub id: u32,
	pub name: String,
	pub args: Vec<Value>,
}

/// Walk the AST and collect every helper invocation in render order.
pub fn collect_invocations(
	ast: &InkerAst,
	data: &Value,
	context: &RenderContext,
) -> Result<Vec<Invocation>, InkerError> {
	let mut tape: Vec<Invocation> = Vec::new();
	collect_nodes(&ast.nodes, data, context, &mut tape, 0)?;
	Ok(tape)
}

const MAX_COLLECT_DEPTH: u32 = 100;

fn collect_nodes(
	nodes: &[InkerNode],
	data: &Value,
	context: &RenderContext,
	tape: &mut Vec<Invocation>,
	depth: u32,
) -> Result<(), InkerError> {
	if depth > MAX_COLLECT_DEPTH {
		return Err(InkerError::new(
			ErrorCode::InvalidExpression,
			format!("Collect recursion exceeded maximum depth {MAX_COLLECT_DEPTH}"),
		));
	}
	for node in nodes {
		collect_node(node, data, context, tape, depth)?;
	}
	Ok(())
}

fn collect_node(
	node: &InkerNode,
	data: &Value,
	context: &RenderContext,
	tape: &mut Vec<Invocation>,
	depth: u32,
) -> Result<(), InkerError> {
	match node {
		InkerNode::Text { .. } | InkerNode::Slot(_) | InkerNode::Layout(_) => {}
		InkerNode::Interpolation { expression, .. } => {
			if let Expression::Call { id, name, args, .. } = expression {
				push_invocation(*id, name, args, data, context, tape)?;
			}
			// Non-call interpolations evaluate no helpers — nothing to collect.
		}
		InkerNode::Partial(p) => {
			let key = normalize_partial_key(&p.name);
			if let Some(partial_ast) = context.partials.get(&key) {
				let mut sub_ctx = context.clone();
				sub_ctx.template_name = Some(p.name.clone());
				collect_nodes(&partial_ast.nodes, data, &sub_ctx, tape, depth + 1)?;
			}
			// Missing partial surfaces as an error at render time, not collect.
		}
		InkerNode::If {
			condition,
			then_nodes,
			else_nodes,
			..
		} => {
			let cond = eval_pure(&condition.expression, data, context)?;
			if json_truthy(&cond) {
				collect_nodes(then_nodes, data, context, tape, depth + 1)?;
			} else if let Some(els) = else_nodes {
				collect_nodes(els, data, context, tape, depth + 1)?;
			}
		}
		InkerNode::Each { .. } => {
			collect_each(node, data, context, tape, depth + 1)?;
		}
		InkerNode::Component(c) => {
			// Args first (tape order), then body — must mirror render.
			let mut scoped = JsonMap::new();
			for arg in &c.args {
				if let Expression::Call { id, name, args, .. } = &arg.value {
					push_invocation(*id, name, args, data, context, tape)?;
					// The component body sees this arg as data; its value is the
					// helper result, only known TS-side. Bodies that re-feed a
					// helper-valued arg into ANOTHER helper are unsupported (untested);
					// bodies that use it as plain data ({{ key }}) are fine because
					// the body's plain interpolation is resolved at render time, not
					// here. Store null as a placeholder so nested helper-arg eval
					// against this scope fails loudly rather than silently.
					scoped.insert(arg.key.clone(), Value::Null);
				} else {
					scoped.insert(arg.key.clone(), eval_pure(&arg.value, data, context)?);
				}
			}
			let key = normalize_partial_key(&c.name);
			if let Some(component_ast) = context.components.get(&key) {
				let scoped_data = Value::Object(scoped);
				let mut sub_ctx = context.clone();
				sub_ctx.template_name = Some(c.name.clone());
				sub_ctx.body_html = None;
				collect_nodes(&component_ast.nodes, &scoped_data, &sub_ctx, tape, depth + 1)?;
			}
		}
	}
	Ok(())
}

fn collect_each(
	node: &InkerNode,
	data: &Value,
	context: &RenderContext,
	tape: &mut Vec<Invocation>,
	depth: u32,
) -> Result<(), InkerError> {
	let (iterable_expr, binding, body_nodes, else_nodes) = match node {
		InkerNode::Each {
			iterable,
			binding,
			body_nodes,
			else_nodes,
			..
		} => (iterable, binding, body_nodes, else_nodes),
		_ => unreachable!("collect_each on non-Each"),
	};

	// eval_pure reproduces render's iterable evaluation. If the iterable shape
	// is invalid, render will raise the precise E_INKER_INVALID_ITERABLE; here
	// we only need to walk the same iterations to collect helpers, so we treat
	// shape errors leniently (skip) and let render produce the canonical error.
	let iterable = match eval_pure(iterable_expr, data, context) {
		Ok(v) => v,
		Err(_) => return Ok(()),
	};

	match binding {
		EachBinding::Single(name) => {
			if let Value::Array(arr) = &iterable {
				if arr.is_empty() {
					if let Some(els) = else_nodes {
						collect_nodes(els, data, context, tape, depth)?;
					}
				} else {
					for item in arr {
						let scoped = merge_scope(data, name, item);
						collect_nodes(body_nodes, &scoped, context, tape, depth)?;
					}
				}
			}
			// Non-array → render raises; collect emits nothing.
			Ok(())
		}
		EachBinding::Destructured([k_name, v_name]) => {
			match &iterable {
				Value::Array(arr) => {
					if arr.is_empty() {
						if let Some(els) = else_nodes {
							collect_nodes(els, data, context, tape, depth)?;
						}
					} else {
						for elem in arr {
							if let Value::Array(pair) = elem {
								if pair.len() == 2 {
									let scoped =
										merge_scope_pair(data, k_name, &pair[0], v_name, &pair[1]);
									collect_nodes(body_nodes, &scoped, context, tape, depth)?;
								}
							}
						}
					}
				}
				Value::Object(obj) => {
					if obj.is_empty() {
						if let Some(els) = else_nodes {
							collect_nodes(els, data, context, tape, depth)?;
						}
					} else {
						for (k, v) in obj {
							if is_prototype_pollution_key(k) {
								continue;
							}
							let scoped =
								merge_scope_pair(data, k_name, &Value::String(k.clone()), v_name, v);
							collect_nodes(body_nodes, &scoped, context, tape, depth)?;
						}
					}
				}
				_ => {}
			}
			Ok(())
		}
	}
}

fn push_invocation(
	id: u32,
	name: &str,
	args: &[Expression],
	data: &Value,
	context: &RenderContext,
	tape: &mut Vec<Invocation>,
) -> Result<(), InkerError> {
	let mut arg_values: Vec<Value> = Vec::with_capacity(args.len());
	for arg in args {
		// eval_pure errors on nested Call args (55.1 limitation), giving a clean
		// E_INKER_INVALID_EXPRESSION instead of silently mis-resolving.
		arg_values.push(eval_pure(arg, data, context)?);
	}
	tape.push(Invocation {
		id,
		name: name.to_string(),
		args: arg_values,
	});
	Ok(())
}

// Local mirrors of render's scope helpers (kept private to avoid widening
// render's public surface). Identical semantics.

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

#[cfg(test)]
mod tests {
	use super::*;
	use crate::lex::{lex, LexOptions};
	use crate::parse::{parse, ParseOptions};
	use serde_json::json;
	use std::collections::HashSet;

	fn parse_with_helpers(s: &str, helpers: &[&str]) -> InkerAst {
		let toks = lex(s, &LexOptions::default()).expect("lex");
		let mut h: HashSet<String> = HashSet::new();
		for n in helpers {
			h.insert((*n).to_string());
		}
		parse(&toks, &ParseOptions { template_path: None, helpers: h }).expect("parse")
	}

	#[test]
	fn collects_bare_interp_helper() {
		let ast = parse_with_helpers("{{ t('greeting') }}", &["t"]);
		let tape =
			collect_invocations(&ast, &json!({}), &RenderContext::default()).unwrap();
		assert_eq!(tape.len(), 1);
		assert_eq!(tape[0].name, "t");
		assert_eq!(tape[0].args, vec![json!("greeting")]);
	}

	#[test]
	fn collects_per_iteration_with_loop_scope() {
		let ast = parse_with_helpers(
			"{% each xs as [k, v] %}{{ url('show', { id: v }) }}{% endeach %}",
			&["url"],
		);
		let data = json!({ "xs": [["a", 1], ["b", 2]] });
		let tape = collect_invocations(&ast, &data, &RenderContext::default()).unwrap();
		assert_eq!(tape.len(), 2);
		assert_eq!(tape[0].args, vec![json!("show"), json!({ "id": 1 })]);
		assert_eq!(tape[1].args, vec![json!("show"), json!({ "id": 2 })]);
	}

	#[test]
	fn conditional_only_collects_taken_branch() {
		let ast = parse_with_helpers(
			"{% if on %}{{ a() }}{% else %}{{ b() }}{% endif %}",
			&["a", "b"],
		);
		let tape_true =
			collect_invocations(&ast, &json!({ "on": true }), &RenderContext::default()).unwrap();
		assert_eq!(tape_true.len(), 1);
		assert_eq!(tape_true[0].name, "a");
		let tape_false =
			collect_invocations(&ast, &json!({ "on": false }), &RenderContext::default()).unwrap();
		assert_eq!(tape_false.len(), 1);
		assert_eq!(tape_false[0].name, "b");
	}

	#[test]
	fn empty_loop_collects_nothing() {
		let ast = parse_with_helpers("{% each xs as i %}{{ f(i) }}{% endeach %}", &["f"]);
		let tape =
			collect_invocations(&ast, &json!({ "xs": [] }), &RenderContext::default()).unwrap();
		assert_eq!(tape.len(), 0);
	}

	#[test]
	fn component_arg_helper_collected() {
		// Body uses the arg as plain data, not as a helper arg.
		let body = parse_with_helpers("{{ text }}", &[]);
		let ast = parse_with_helpers("{% component 'b' { text: t('greeting') } %}", &["t"]);
		let mut ctx = RenderContext::default();
		ctx.components.insert("b".to_string(), body);
		let tape = collect_invocations(&ast, &json!({}), &ctx).unwrap();
		assert_eq!(tape.len(), 1);
		assert_eq!(tape[0].name, "t");
	}

	#[test]
	fn nested_call_arg_errors() {
		let ast = parse_with_helpers("{{ a(b('x')) }}", &["a", "b"]);
		let e = collect_invocations(&ast, &json!({}), &RenderContext::default()).unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidExpression);
	}
}
