// PATTERN: copy-and-rename for 55.2/55.3/55.4 — Rust hot-path packages.
//
// NAPI boundary for `inker-engine`. Exposes:
//   - `parseTemplate(source, helpers)` → opaque `InkerAst` handle (Arc-backed).
//   - `InkerAst#composeInfo` getter — partials / components / layout metadata
//     consumed by the TS-side compose walk.
//   - `collectInvocations(ast, data, ctx)` — returns an ordered tape of
//     `{ id, name, args }` with each arg already resolved against runtime data.
//     The TS-side invokes each entry's helper (sync), packs `{ value, is_safe }`
//     per ADR-007, and passes the resolved map to `renderAst`.
//   - `renderAst(ast, data, helpers, ctx)` — synchronous render with the
//     pre-resolved helpers map.
//   - InkerError → napi::Error: message is `JSON.stringify(InkerNapiErrorPayload)`
//     so the TS-side can reconstruct an `InkerRenderError` with the correct
//     `code` / `line` / `column` / `templateName`.

use inker_engine::ast::InkerNode;
use inker_engine::error::InkerError;
use inker_engine::parse::{parse as engine_parse, InkerAst as EngineAst, ParseOptions};
use inker_engine::render::{
	render as engine_render, RenderContext, ResolvedHelperValue,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Serialize;
use std::collections::HashSet;
use std::panic::catch_unwind;
use std::sync::Arc;

#[derive(Serialize)]
struct InkerNapiErrorPayload {
	code: String,
	message: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	line: Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	column: Option<u32>,
	#[serde(rename = "templateName", skip_serializing_if = "Option::is_none")]
	template_name: Option<String>,
}

fn to_napi_error(e: InkerError) -> napi::Error {
	let payload = InkerNapiErrorPayload {
		code: e.code.as_str().to_string(),
		message: e.message.clone(),
		line: e.line,
		column: e.column,
		template_name: e.template_name.clone(),
	};
	let json = serde_json::to_string(&payload).unwrap_or_else(|_| {
		// Fallback — should never happen for these scalar fields.
		format!("{{\"code\":\"E_INKER_PARSE_ERROR\",\"message\":\"{}\"}}", e.message)
	});
	napi::Error::from_reason(json)
}

fn wrap<T, F>(f: F) -> Result<T>
where
	T: Send + 'static,
	F: FnOnce() -> std::result::Result<T, InkerError> + std::panic::UnwindSafe,
{
	match catch_unwind(f) {
		Ok(Ok(v)) => Ok(v),
		Ok(Err(e)) => Err(to_napi_error(e)),
		Err(_) => Err(napi::Error::from_reason("Internal panic in inker engine")),
	}
}

/// Opaque handle to a parsed Inker AST. The TS-side `Templates#cache` keeps
/// these instances alive; when the JS GC collects the wrapper, napi-rs drops
/// the inner `Arc` automatically (D55.1.3 — Arc + GC bridge replaces a manual
/// dispose API).
#[napi]
pub struct InkerAst {
	inner: Arc<EngineAst>,
}

/// A `{% include %}` / `{% component %}` reference with its source position
/// (for circular-include error context).
#[napi(object)]
pub struct NodeRefNapi {
	pub name: String,
	pub line: u32,
	pub column: u32,
}

/// A `{{> name }}` slot reference.
#[napi(object)]
pub struct SlotRefNapi {
	pub name: String,
	pub line: u32,
	pub column: u32,
}

/// First disk-requiring node (for `renderString`'s E_INKER_DISK_REQUIRED guard).
#[napi(object)]
pub struct DiskNodeRefNapi {
	pub kind: String,
	pub name: String,
}

/// All metadata `Templates#compose` needs from a parsed AST in ONE call, so the
/// TS composer never walks the opaque native node tree itself.
#[napi(object)]
pub struct ComposeInfoNapi {
	pub has_layout: bool,
	pub layout_name: Option<String>,
	pub layout_line: Option<u32>,
	pub layout_column: Option<u32>,
	pub slots: Vec<SlotRefNapi>,
	pub partials: Vec<NodeRefNapi>,
	pub components: Vec<NodeRefNapi>,
	pub has_content: bool,
	pub first_disk_node: Option<DiskNodeRefNapi>,
}

#[napi]
impl InkerAst {
	/// One-shot composition metadata. Mirrors the TS-side AST-walk helpers
	/// (`findFirstSlotIn` / `hasBodySlotInNodes` / `findFirstDiskNode` /
	/// `bodyHasContent` / `collect{Partial,Component}Nodes`) so the composer
	/// stays in TS (it owns FS access) while node-tree walking stays in Rust.
	#[napi(getter)]
	pub fn compose_info(&self) -> ComposeInfoNapi {
		let mut slots: Vec<SlotRefNapi> = Vec::new();
		collect_slots(&self.inner.nodes, &mut slots);
		let mut partials: Vec<NodeRefNapi> = Vec::new();
		collect_partials(&self.inner.nodes, &mut partials);
		let mut components: Vec<NodeRefNapi> = Vec::new();
		collect_components(&self.inner.nodes, &mut components);
		let (layout_name, layout_line, layout_column) = match &self.inner.layout {
			Some(l) => (Some(l.name.clone()), Some(l.line), Some(l.column)),
			None => (None, None, None),
		};
		ComposeInfoNapi {
			has_layout: self.inner.layout.is_some(),
			layout_name,
			layout_line,
			layout_column,
			slots,
			partials,
			components,
			has_content: nodes_have_content(&self.inner.nodes),
			first_disk_node: first_disk_node(&self.inner.nodes),
		}
	}
}

fn collect_slots(nodes: &[InkerNode], out: &mut Vec<SlotRefNapi>) {
	for n in nodes {
		match n {
			InkerNode::Slot(s) => out.push(SlotRefNapi {
				name: s.name.clone(),
				line: s.line,
				column: s.column,
			}),
			InkerNode::If { then_nodes, else_nodes, .. } => {
				collect_slots(then_nodes, out);
				if let Some(el) = else_nodes {
					collect_slots(el, out);
				}
			}
			InkerNode::Each { body_nodes, else_nodes, .. } => {
				collect_slots(body_nodes, out);
				if let Some(el) = else_nodes {
					collect_slots(el, out);
				}
			}
			_ => {}
		}
	}
}

/// `bodyHasContent` parity: any non-whitespace Text, OR any non-Text node, is
/// content. (An empty If/Each at top level still counts — matches TS.)
fn nodes_have_content(nodes: &[InkerNode]) -> bool {
	for n in nodes {
		match n {
			InkerNode::Text { value } => {
				if !value.chars().all(|c| c == ' ' || c == '\t' || c == '\n' || c == '\r') {
					return true;
				}
			}
			_ => return true,
		}
	}
	false
}

fn first_disk_node(nodes: &[InkerNode]) -> Option<DiskNodeRefNapi> {
	for n in nodes {
		match n {
			InkerNode::Layout(l) => {
				return Some(DiskNodeRefNapi { kind: "Layout".into(), name: l.name.clone() })
			}
			InkerNode::Partial(p) => {
				return Some(DiskNodeRefNapi { kind: "Partial".into(), name: p.name.clone() })
			}
			InkerNode::Slot(s) => {
				return Some(DiskNodeRefNapi { kind: "Slot".into(), name: s.name.clone() })
			}
			InkerNode::Component(c) => {
				return Some(DiskNodeRefNapi { kind: "Component".into(), name: c.name.clone() })
			}
			InkerNode::If { then_nodes, else_nodes, .. } => {
				if let Some(d) = first_disk_node(then_nodes) {
					return Some(d);
				}
				if let Some(el) = else_nodes {
					if let Some(d) = first_disk_node(el) {
						return Some(d);
					}
				}
			}
			InkerNode::Each { body_nodes, else_nodes, .. } => {
				if let Some(d) = first_disk_node(body_nodes) {
					return Some(d);
				}
				if let Some(el) = else_nodes {
					if let Some(d) = first_disk_node(el) {
						return Some(d);
					}
				}
			}
			_ => {}
		}
	}
	None
}

fn collect_partials(nodes: &[InkerNode], out: &mut Vec<NodeRefNapi>) {
	for n in nodes {
		match n {
			InkerNode::Partial(p) => out.push(NodeRefNapi {
				name: p.name.clone(),
				line: p.line,
				column: p.column,
			}),
			InkerNode::If {
				then_nodes,
				else_nodes,
				..
			} => {
				collect_partials(then_nodes, out);
				if let Some(el) = else_nodes {
					collect_partials(el, out);
				}
			}
			InkerNode::Each {
				body_nodes,
				else_nodes,
				..
			} => {
				collect_partials(body_nodes, out);
				if let Some(el) = else_nodes {
					collect_partials(el, out);
				}
			}
			_ => {}
		}
	}
}

fn collect_components(nodes: &[InkerNode], out: &mut Vec<NodeRefNapi>) {
	for n in nodes {
		match n {
			InkerNode::Component(c) => out.push(NodeRefNapi {
				name: c.name.clone(),
				line: c.line,
				column: c.column,
			}),
			InkerNode::If {
				then_nodes,
				else_nodes,
				..
			} => {
				collect_components(then_nodes, out);
				if let Some(el) = else_nodes {
					collect_components(el, out);
				}
			}
			InkerNode::Each {
				body_nodes,
				else_nodes,
				..
			} => {
				collect_components(body_nodes, out);
				if let Some(el) = else_nodes {
					collect_components(el, out);
				}
			}
			_ => {}
		}
	}
}

/// Parse a template source string into an opaque `InkerAst` handle.
///
/// `helpers_set` lists the helper names the parser should accept inside
/// `{{ name(...) }}` call positions. Names not in this set produce an
/// `E_INKER_UNKNOWN_HELPER` at parse time (no rendering required).
#[napi]
pub fn parse_template(source: String, helpers_set: Vec<String>) -> Result<InkerAst> {
	wrap(move || {
		let toks = inker_engine::lex::lex(&source, &inker_engine::lex::LexOptions::default())?;
		let mut helpers: HashSet<String> = HashSet::new();
		for h in helpers_set {
			helpers.insert(h);
		}
		let opts = ParseOptions {
			template_path: None,
			helpers,
		};
		let ast = engine_parse(&toks, &opts)?;
		Ok(InkerAst {
			inner: Arc::new(ast),
		})
	})
}

/// One pre-resolved helper result, consumed in tape order by the renderer.
#[napi(object)]
pub struct HelperResultNapi {
	pub value: String,
	pub is_safe: bool,
}

/// One helper invocation request produced by `collectInvocations`. The TS side
/// invokes `helpers.get(name)(...args)` and packs the result into the
/// corresponding `HelperResultNapi` slot (same order).
#[napi(object)]
pub struct InvocationNapi {
	pub id: u32,
	pub name: String,
	/// JSON array of the in-scope-evaluated argument values.
	pub args: serde_json::Value,
}

#[napi(object)]
pub struct RenderContextNapi {
	#[napi(ts_type = "Record<string, InkerAst>")]
	pub partials: std::collections::HashMap<String, ClassInstance<InkerAst>>,
	#[napi(ts_type = "Record<string, InkerAst>")]
	pub components: std::collections::HashMap<String, ClassInstance<InkerAst>>,
	pub body_html: Option<String>,
	pub template_name: Option<String>,
	pub template_path: Option<String>,
}

fn build_render_context(ctx: RenderContextNapi) -> RenderContext {
	let partials_typed = ctx
		.partials
		.into_iter()
		.map(|(k, v)| (k, (*v.inner).clone()))
		.collect::<std::collections::HashMap<String, EngineAst>>();
	let components_typed = ctx
		.components
		.into_iter()
		.map(|(k, v)| (k, (*v.inner).clone()))
		.collect::<std::collections::HashMap<String, EngineAst>>();
	RenderContext {
		template_path: ctx.template_path,
		template_name: ctx.template_name,
		partials: partials_typed,
		components: components_typed,
		body_html: ctx.body_html,
	}
}

/// ADR-007 pass 1 — walk the control flow with `data` and return the ordered
/// tape of helper invocations (one entry per execution, loop/conditional aware).
/// The TS side invokes each helper and feeds the results to `renderAst`.
#[napi]
pub fn collect_invocations(
	ast: &InkerAst,
	data: serde_json::Value,
	ctx: RenderContextNapi,
) -> Result<Vec<InvocationNapi>> {
	let inner_ast = ast.inner.clone();
	// build_render_context consumes the napi ClassInstance handles, so it runs
	// outside wrap() (the closure must be UnwindSafe — only owned Rust data).
	let render_ctx = build_render_context(ctx);
	wrap(move || {
		let tape = inker_engine::collect::collect_invocations(&inner_ast, &data, &render_ctx)?;
		Ok(tape
			.into_iter()
			.map(|inv| InvocationNapi {
				id: inv.id,
				name: inv.name,
				args: serde_json::Value::Array(inv.args),
			})
			.collect())
	})
}

/// ADR-007 pass 2 — render the AST consuming the pre-resolved helper tape in
/// the identical walk order that `collectInvocations` produced it.
#[napi]
pub fn render_ast(
	ast: &InkerAst,
	data: serde_json::Value,
	resolved: Vec<HelperResultNapi>,
	ctx: RenderContextNapi,
) -> Result<String> {
	let inner_ast = ast.inner.clone();
	let tape: Vec<ResolvedHelperValue> = resolved
		.into_iter()
		.map(|r| {
			if r.is_safe {
				ResolvedHelperValue::Safe(r.value)
			} else {
				ResolvedHelperValue::Plain(r.value)
			}
		})
		.collect();
	// build_render_context consumes the napi ClassInstance handles, so it runs
	// outside wrap() (the closure must be UnwindSafe — only owned Rust data).
	let render_ctx = build_render_context(ctx);
	wrap(move || engine_render(&inner_ast, &data, &render_ctx, &tape))
}

/// Crate version — useful for the TS-side `loadNapi.ts` startup diagnostic.
#[napi]
pub fn engine_version() -> &'static str {
	env!("CARGO_PKG_VERSION")
}
