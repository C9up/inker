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

/// A `@include()` / `@component()` reference with its source position
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
/// Does the child have BODY content — the part a layout renders at
/// `{{> body }}`?
///
/// A top-level `@section` is NOT body content: it fills one of the layout's
/// named yields. Counting it made a layout built only of `@section` yields (the
/// canonical shape) reject a child built only of `@section` fills, reporting a
/// missing `{{> body }}` for a body that was empty all along.
fn nodes_have_content(nodes: &[InkerNode]) -> bool {
	for n in nodes {
		match n {
			InkerNode::Text { value } => {
				if !value.chars().all(|c| c == ' ' || c == '\t' || c == '\n' || c == '\r') {
					return true;
				}
			}
			InkerNode::Section { .. } => {}
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
			InkerNode::Component(c) => {
				// A `@component()` block body / named slots is caller content
				// that may `@include()` partials — walk it so they pre-load.
				collect_partials(&c.body_nodes, out);
				for slot in &c.named_slots {
					collect_partials(&slot.nodes, out);
				}
			}
			_ => {}
		}
	}
}

fn collect_components(nodes: &[InkerNode], out: &mut Vec<NodeRefNapi>) {
	for n in nodes {
		match n {
			InkerNode::Component(c) => {
				out.push(NodeRefNapi {
					name: c.name.clone(),
					line: c.line,
					column: c.column,
				});
				// A `@component()` block body / named slots is caller content
				// that may invoke further components — walk it so they pre-load.
				collect_components(&c.body_nodes, out);
				for slot in &c.named_slots {
					collect_components(&slot.nodes, out);
				}
			}
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
///
/// `custom_tags_set` lists the runtime-registered custom-tag names (Edge
/// `registerTag`); the lexer/parser recognise `@<name>(args)` for each and emit
/// a `CustomTag` node the Node renderer resolves against its handler registry.
/// `custom_block_tags_set` is the subset registered with `block: true`: those
/// open a body closed by `@end<name>` (or self-close as `@!<name>`).
#[napi]
pub fn parse_template(
	source: String,
	helpers_set: Vec<String>,
	custom_tags_set: Vec<String>,
	custom_block_tags_set: Vec<String>,
	component_tags_json: String,
) -> Result<InkerAst> {
	wrap(move || {
		let component_tags: std::collections::HashMap<String, String> =
			if component_tags_json.is_empty() {
				std::collections::HashMap::new()
			} else {
				serde_json::from_str(&component_tags_json).map_err(|e| {
					inker_engine::error::InkerError::new(
						inker_engine::error::ErrorCode::ParseError,
						format!("invalid component_tags JSON: {e}"),
					)
				})?
			};
		let mut custom_tags: HashSet<String> = custom_tags_set.into_iter().collect();
		let mut custom_block_tags: HashSet<String> =
			custom_block_tags_set.into_iter().collect();
		// A component tag lexes exactly like a registered block tag — `@button`,
		// `@endbutton`, `@!button`. Only the PARSER distinguishes them, turning
		// them into component invocations instead of custom-tag nodes.
		for name in component_tags.keys() {
			custom_tags.insert(name.clone());
			custom_block_tags.insert(name.clone());
		}
		let lex_opts = inker_engine::lex::LexOptions {
			template_path: None,
			custom_tags: custom_tags.clone(),
			custom_block_tags: custom_block_tags.clone(),
		};
		let toks = inker_engine::lex::lex(&source, &lex_opts)?;
		let mut helpers: HashSet<String> = HashSet::new();
		for h in helpers_set {
			helpers.insert(h);
		}
		let opts = ParseOptions {
			template_path: None,
			helpers,
			custom_tags,
			custom_block_tags,
			component_tags,
		};
		let ast = engine_parse(&toks, &opts)?;
		Ok(InkerAst {
			inner: Arc::new(ast),
		})
	})
}

/// Parse a template and return its AST as a walkable JSON string (nodes +
/// layout). This is the artifact the Node-side renderer consumes: Rust does the
/// CPU-bound lex/parse, Node evaluates expressions in V8 and renders (Edge
/// model — 62-2 pivot away from the embedded QuickJS VM). Each node carries the
/// verbatim `source` of its expressions, which the Node renderer evaluates.
#[napi]
pub fn parse_template_json(
	source: String,
	helpers_set: Vec<String>,
	custom_tags_set: Vec<String>,
	custom_block_tags_set: Vec<String>,
	component_tags_json: String,
) -> Result<String> {
	wrap(move || {
		let component_tags: std::collections::HashMap<String, String> =
			if component_tags_json.is_empty() {
				std::collections::HashMap::new()
			} else {
				serde_json::from_str(&component_tags_json).map_err(|e| {
					inker_engine::error::InkerError::new(
						inker_engine::error::ErrorCode::ParseError,
						format!("invalid component_tags JSON: {e}"),
					)
				})?
			};
		let mut custom_tags: HashSet<String> = custom_tags_set.into_iter().collect();
		let mut custom_block_tags: HashSet<String> =
			custom_block_tags_set.into_iter().collect();
		// A component tag lexes exactly like a registered block tag — `@button`,
		// `@endbutton`, `@!button`. Only the PARSER distinguishes them, turning
		// them into component invocations instead of custom-tag nodes.
		for name in component_tags.keys() {
			custom_tags.insert(name.clone());
			custom_block_tags.insert(name.clone());
		}
		let lex_opts = inker_engine::lex::LexOptions {
			template_path: None,
			custom_tags: custom_tags.clone(),
			custom_block_tags: custom_block_tags.clone(),
		};
		let toks = inker_engine::lex::lex(&source, &lex_opts)?;
		let mut helpers: HashSet<String> = HashSet::new();
		for h in helpers_set {
			helpers.insert(h);
		}
		let opts = ParseOptions {
			template_path: None,
			helpers,
			custom_tags,
			custom_block_tags,
			component_tags,
		};
		let ast = engine_parse(&toks, &opts)?;
		let json = serde_json::json!({ "nodes": ast.nodes, "layout": ast.layout });
		serde_json::to_string(&json).map_err(|e| {
			inker_engine::error::InkerError::new(
				inker_engine::error::ErrorCode::ParseError,
				format!("AST serialization failed: {e}"),
			)
		})
	})
}

/// Serialize an already-parsed AST handle to a walkable JSON string (nodes +
/// layout) for the Node-side renderer (62-2 pivot). Reuses the cached parse —
/// no re-parse — so `Templates` keeps its disk/cache/compose machinery intact.
#[napi]
pub fn ast_to_json(ast: &InkerAst) -> Result<String> {
	let json = serde_json::json!({ "nodes": ast.inner.nodes, "layout": ast.inner.layout });
	serde_json::to_string(&json).map_err(|e| Error::from_reason(e.to_string()))
}

/// Crate version — useful for the TS-side `loadNapi.ts` startup diagnostic.
#[napi]
pub fn engine_version() -> &'static str {
	env!("CARGO_PKG_VERSION")
}
