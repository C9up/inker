//! Top-level parser — mirrors `packages/inker/src/parse.ts` 1:1.
//!
//! Consumes the `Vec<Token>` from `lex::lex`, dispatches block tags through
//! `parse_block_tag::parse_block_tag`, balances `{% if %}` / `{% each %}` /
//! `{% else %}` / `{% endif %}` / `{% endeach %}` via a frame stack, and
//! assembles the final `InkerAst`. Also collects every helper call-site for
//! the ADR-007 TS-side pre-resolve walk (AC6).

use crate::ast::{EachBinding, IfCondition, InkerNode, LayoutNode, SlotNode};
use crate::error::{ErrorCode, InkerError};
use crate::lex::Token;
use crate::parse_block_tag::{
	parse_block_tag, BlockClosesKind, ParseBlockTagOptions, ParsedBlockTag,
};
use crate::parse_expression::{
	parse_expression_with_helper_count, Expression, ParseExpressionOptions,
};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq)]
pub struct InkerAst {
	pub nodes: Vec<InkerNode>,
	pub layout: Option<LayoutNode>,
	pub helper_call_sites: Vec<HelperCallSite>,
	pub helper_count: u32,
}

/// One Call expression in the AST. The TS-side `Templates#render` walks this
/// list, evaluates `args` against the runtime data tree, invokes
/// `helpers.get(name)(...evaluatedArgs)`, packs the result by `id`, and ships
/// the packed map to `render_ast`. The Rust renderer then does O(1) lookup by
/// id — no V8 callback, no ThreadsafeFunction.
#[derive(Debug, Clone, PartialEq)]
pub struct HelperCallSite {
	pub id: u32,
	pub name: String,
	pub args: Vec<Expression>,
	pub line: u32,
	pub column: u32,
}

#[derive(Debug, Default, Clone)]
pub struct ParseOptions {
	pub template_path: Option<String>,
	pub helpers: HashSet<String>,
}

fn is_whitespace_only(value: &str) -> bool {
	value
		.chars()
		.all(|c| c == ' ' || c == '\t' || c == '\n' || c == '\r')
}

enum BlockFrame {
	If {
		line: u32,
		column: u32,
		condition: IfCondition,
		then_nodes: Vec<InkerNode>,
		else_nodes: Option<Vec<InkerNode>>,
		in_else: bool,
	},
	Each {
		line: u32,
		column: u32,
		iterable: Expression,
		iterable_source: String,
		binding: EachBinding,
		body_nodes: Vec<InkerNode>,
		else_nodes: Option<Vec<InkerNode>>,
		in_else: bool,
	},
}

impl BlockFrame {
	fn active_mut(&mut self) -> &mut Vec<InkerNode> {
		match self {
			BlockFrame::If {
				then_nodes,
				else_nodes,
				in_else,
				..
			} => {
				if *in_else {
					else_nodes.get_or_insert_with(Vec::new)
				} else {
					then_nodes
				}
			}
			BlockFrame::Each {
				body_nodes,
				else_nodes,
				in_else,
				..
			} => {
				if *in_else {
					else_nodes.get_or_insert_with(Vec::new)
				} else {
					body_nodes
				}
			}
		}
	}

	fn kind_label(&self) -> &'static str {
		match self {
			BlockFrame::If { .. } => "If",
			BlockFrame::Each { .. } => "Each",
		}
	}

	fn line(&self) -> u32 {
		match self {
			BlockFrame::If { line, .. } | BlockFrame::Each { line, .. } => *line,
		}
	}

	fn column(&self) -> u32 {
		match self {
			BlockFrame::If { column, .. } | BlockFrame::Each { column, .. } => *column,
		}
	}
}

fn push_node(
	node: InkerNode,
	root_nodes: &mut Vec<InkerNode>,
	open_blocks: &mut [BlockFrame],
) {
	if open_blocks.is_empty() {
		root_nodes.push(node);
		return;
	}
	let last_idx = open_blocks.len() - 1;
	open_blocks[last_idx].active_mut().push(node);
}

fn make_err(
	code: ErrorCode,
	message: impl Into<String>,
	line: u32,
	column: u32,
	template_path: Option<&str>,
) -> InkerError {
	let mut e = InkerError::new(code, message)
		.with_pos(line, column);
	if let Some(t) = template_path {
		e = e.with_template(t.to_string());
	}
	e
}

fn collect_helpers_in_expr(expr: &Expression, out: &mut Vec<HelperCallSite>) {
	match expr {
		Expression::Call {
			name,
			args,
			id,
			line,
			column,
			..
		} => {
			// Children first (matches the inner-first id assignment so the
			// collected order is by id ascending).
			for a in args {
				collect_helpers_in_expr(a, out);
			}
			out.push(HelperCallSite {
				id: *id,
				name: name.clone(),
				args: args.clone(),
				line: *line,
				column: *column,
			});
		}
		Expression::Object { entries, .. } => {
			for e in entries {
				collect_helpers_in_expr(&e.value, out);
			}
		}
		Expression::Unary { operand, .. } => collect_helpers_in_expr(operand, out),
		Expression::Binary { left, right, .. } => {
			collect_helpers_in_expr(left, out);
			collect_helpers_in_expr(right, out);
		}
		Expression::Group { expression, .. } => collect_helpers_in_expr(expression, out),
		Expression::Literal { .. } | Expression::Path { .. } => {}
	}
}

fn collect_helpers_in_node(node: &InkerNode, out: &mut Vec<HelperCallSite>) {
	match node {
		InkerNode::Interpolation { expression, .. } => {
			collect_helpers_in_expr(expression, out);
		}
		InkerNode::If {
			condition,
			then_nodes,
			else_nodes,
			..
		} => {
			collect_helpers_in_expr(&condition.expression, out);
			for n in then_nodes {
				collect_helpers_in_node(n, out);
			}
			if let Some(en) = else_nodes {
				for n in en {
					collect_helpers_in_node(n, out);
				}
			}
		}
		InkerNode::Each {
			iterable,
			body_nodes,
			else_nodes,
			..
		} => {
			collect_helpers_in_expr(iterable, out);
			for n in body_nodes {
				collect_helpers_in_node(n, out);
			}
			if let Some(en) = else_nodes {
				for n in en {
					collect_helpers_in_node(n, out);
				}
			}
		}
		InkerNode::Component(c) => {
			for a in &c.args {
				collect_helpers_in_expr(&a.value, out);
			}
		}
		InkerNode::Text { .. }
		| InkerNode::Layout(_)
		| InkerNode::Partial(_)
		| InkerNode::Slot(_) => {}
	}
}

pub fn parse(
	tokens: &[Token],
	options: &ParseOptions,
) -> Result<InkerAst, InkerError> {
	let template_path = options.template_path.as_deref();
	let mut root_nodes: Vec<InkerNode> = Vec::new();
	let mut open_blocks: Vec<BlockFrame> = Vec::new();
	let mut seen_layout: Option<(u32, u32)> = None;
	let mut layout: Option<LayoutNode> = None;
	let mut seen_non_whitespace_content = false;
	let mut helper_id_counter: u32 = 0;

	for token in tokens {
		match token {
			Token::Text { value, .. } => {
				let node = InkerNode::Text {
					value: value.clone(),
				};
				push_node(node, &mut root_nodes, &mut open_blocks);
				if open_blocks.is_empty() && !is_whitespace_only(value) {
					seen_non_whitespace_content = true;
				}
			}
			Token::InterpEscaped {
				expression,
				line,
				column,
				expr_line,
				expr_column,
			}
			| Token::InterpRaw {
				expression,
				line,
				column,
				expr_line,
				expr_column,
			} => {
				let is_escaped = matches!(token, Token::InterpEscaped { .. });
				let opts = ParseExpressionOptions {
					template_path: template_path.map(|s| s.to_string()),
					helpers: options.helpers.clone(),
				};
				let (expr, next_id) = parse_expression_with_helper_count(
					expression,
					*expr_line,
					*expr_column,
					&opts,
					helper_id_counter,
				)?;
				helper_id_counter = next_id;
				let node = InkerNode::Interpolation {
					expression: expr,
					escape: is_escaped,
					source: expression.clone(),
					line: *line,
					column: *column,
				};
				push_node(node, &mut root_nodes, &mut open_blocks);
				if open_blocks.is_empty() {
					seen_non_whitespace_content = true;
				}
			}
			Token::SlotPlaceholder { name, line, column } => {
				let node = InkerNode::Slot(SlotNode {
					name: name.clone(),
					line: *line,
					column: *column,
				});
				push_node(node, &mut root_nodes, &mut open_blocks);
				if open_blocks.is_empty() {
					seen_non_whitespace_content = true;
				}
			}
			Token::BlockTag { raw, line, column } => {
				let bt_opts = ParseBlockTagOptions {
					template_path: template_path.map(|s| s.to_string()),
					helpers: options.helpers.clone(),
				};
				let (parsed, next_id) =
					parse_block_tag(raw, *line, *column, &bt_opts, helper_id_counter)?;
				helper_id_counter = next_id;

				match parsed {
					ParsedBlockTag::Layout(layout_node) => {
						if !open_blocks.is_empty() {
							return Err(make_err(
								ErrorCode::InvalidLayoutPosition,
								format!(
									"{{% layout %}} must be the first directive in the template (got at line {}, column {} inside a block)",
									token.line(), token.column()
								),
								*line,
								*column,
								template_path,
							));
						}
						if let Some((sl_line, _)) = seen_layout {
							return Err(make_err(
								ErrorCode::DuplicateLayout,
								format!(
									"{{% layout %}} declared twice (first at line {sl_line}, second at line {})",
									*line
								),
								*line,
								*column,
								template_path,
							));
						}
						if seen_non_whitespace_content {
							return Err(make_err(
								ErrorCode::InvalidLayoutPosition,
								format!(
									"{{% layout %}} must be the first directive in the template (got at line {}, column {} after non-whitespace content)",
									*line, *column
								),
								*line,
								*column,
								template_path,
							));
						}
						// Strip a trailing whitespace-only TextNode before the layout.
						if let Some(InkerNode::Text { value }) = root_nodes.last() {
							if is_whitespace_only(value) {
								root_nodes.pop();
							}
						}
						seen_layout = Some((*line, *column));
						layout = Some(layout_node);
					}
					ParsedBlockTag::Partial(partial_node) => {
						push_node(
							InkerNode::Partial(partial_node),
							&mut root_nodes,
							&mut open_blocks,
						);
						if open_blocks.is_empty() {
							seen_non_whitespace_content = true;
						}
					}
					ParsedBlockTag::Component(component_node) => {
						push_node(
							InkerNode::Component(component_node),
							&mut root_nodes,
							&mut open_blocks,
						);
						if open_blocks.is_empty() {
							seen_non_whitespace_content = true;
						}
					}
					ParsedBlockTag::OpenIf {
						condition,
						line: pl,
						column: pc,
					} => {
						open_blocks.push(BlockFrame::If {
							line: pl,
							column: pc,
							condition,
							then_nodes: Vec::new(),
							else_nodes: None,
							in_else: false,
						});
						if open_blocks.len() == 1 {
							seen_non_whitespace_content = true;
						}
					}
					ParsedBlockTag::OpenEach {
						iterable,
						iterable_source,
						binding,
						line: pl,
						column: pc,
					} => {
						open_blocks.push(BlockFrame::Each {
							line: pl,
							column: pc,
							iterable,
							iterable_source,
							binding,
							body_nodes: Vec::new(),
							else_nodes: None,
							in_else: false,
						});
						if open_blocks.len() == 1 {
							seen_non_whitespace_content = true;
						}
					}
					ParsedBlockTag::Else {
						line: pl,
						column: pc,
					} => {
						let top = match open_blocks.last_mut() {
							Some(t) => t,
							None => {
								return Err(make_err(
									ErrorCode::UnmatchedBlockEnd,
									format!(
										"{{% else %}} with no open {{% if %}} or {{% each %}} (at line {pl}, column {pc})"
									),
									pl,
									pc,
									template_path,
								));
							}
						};
						let already = match top {
							BlockFrame::If { in_else, .. } => *in_else,
							BlockFrame::Each { in_else, .. } => *in_else,
						};
						if already {
							let kw = match top {
								BlockFrame::If { .. } => "if",
								BlockFrame::Each { .. } => "each",
							};
							let frame_line = top.line();
							return Err(make_err(
								ErrorCode::InvalidExpression,
								format!(
									"Multiple {{% else %}} clauses in the same {{% {kw} %}} block (open at line {frame_line}, second else at line {pl})"
								),
								pl,
								pc,
								template_path,
							));
						}
						match top {
							BlockFrame::If {
								in_else,
								else_nodes,
								..
							} => {
								*in_else = true;
								*else_nodes = Some(Vec::new());
							}
							BlockFrame::Each {
								in_else,
								else_nodes,
								..
							} => {
								*in_else = true;
								*else_nodes = Some(Vec::new());
							}
						}
					}
					ParsedBlockTag::Close {
						closes,
						line: pl,
						column: pc,
					} => {
						let top = match open_blocks.last() {
							Some(t) => t,
							None => {
								let kw = match closes {
									BlockClosesKind::If => "endif",
									BlockClosesKind::Each => "endeach",
								};
								return Err(make_err(
									ErrorCode::UnmatchedBlockEnd,
									format!(
										"{{% {kw} %}} with no open block (at line {pl}, column {pc})"
									),
									pl,
									pc,
									template_path,
								));
							}
						};
						let top_kind = match top {
							BlockFrame::If { .. } => BlockClosesKind::If,
							BlockFrame::Each { .. } => BlockClosesKind::Each,
						};
						if top_kind != closes {
							let open_kw = match top {
								BlockFrame::If { .. } => "if",
								BlockFrame::Each { .. } => "each",
							};
							let close_kw = match closes {
								BlockClosesKind::If => "endif",
								BlockClosesKind::Each => "endeach",
							};
							let top_line = top.line();
							let top_col = top.column();
							return Err(make_err(
								ErrorCode::MismatchedBlockEnd,
								format!(
									"{{% {close_kw} %}} does not match open {{% {open_kw} %}} (open at line {top_line}, column {top_col}; close at line {pl}, column {pc})"
								),
								pl,
								pc,
								template_path,
							));
						}
						let frame = open_blocks.pop().expect("checked above");
						let node = match frame {
							BlockFrame::If {
								line,
								column,
								condition,
								then_nodes,
								else_nodes,
								..
							} => InkerNode::If {
								condition,
								then_nodes,
								else_nodes,
								line,
								column,
							},
							BlockFrame::Each {
								line,
								column,
								iterable,
								iterable_source,
								binding,
								body_nodes,
								else_nodes,
								..
							} => InkerNode::Each {
								iterable,
								iterable_source,
								binding,
								body_nodes,
								else_nodes,
								line,
								column,
							},
						};
						push_node(node, &mut root_nodes, &mut open_blocks);
					}
				}
			}
		}
	}

	if let Some(top) = open_blocks.last() {
		let kw = top.kind_label();
		let kw_lower = if kw == "If" { "if" } else { "each" };
		return Err(make_err(
			ErrorCode::UnclosedBlock,
			format!(
				"{{% {kw_lower} %}} started at line {}, column {} was never closed",
				top.line(),
				top.column()
			),
			top.line(),
			top.column(),
			template_path,
		));
	}

	// Collect helper call-sites — walk the assembled tree.
	let mut helper_call_sites: Vec<HelperCallSite> = Vec::new();
	for node in &root_nodes {
		collect_helpers_in_node(node, &mut helper_call_sites);
	}
	// Stable sort by id keeps the TS-side pre-resolve walking inner-first.
	helper_call_sites.sort_by_key(|s| s.id);

	Ok(InkerAst {
		nodes: root_nodes,
		layout,
		helper_call_sites,
		helper_count: helper_id_counter,
	})
}

// Expose the Token kind-extraction (line/column) used in error wording.
impl Token {
	fn line(&self) -> u32 {
		match self {
			Token::Text { line, .. }
			| Token::InterpEscaped { line, .. }
			| Token::InterpRaw { line, .. }
			| Token::BlockTag { line, .. }
			| Token::SlotPlaceholder { line, .. } => *line,
		}
	}
	fn column(&self) -> u32 {
		match self {
			Token::Text { column, .. }
			| Token::InterpEscaped { column, .. }
			| Token::InterpRaw { column, .. }
			| Token::BlockTag { column, .. }
			| Token::SlotPlaceholder { column, .. } => *column,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::lex::{lex, LexOptions};

	fn parse_str(s: &str) -> Result<InkerAst, InkerError> {
		let tokens = lex(s, &LexOptions::default()).expect("lex");
		parse(&tokens, &ParseOptions::default())
	}

	#[test]
	fn pure_text() {
		let ast = parse_str("hello").unwrap();
		assert_eq!(ast.nodes.len(), 1);
		assert!(matches!(ast.nodes[0], InkerNode::Text { .. }));
		assert!(ast.layout.is_none());
		assert_eq!(ast.helper_count, 0);
	}

	#[test]
	fn interp_emits_interpolation_node() {
		let ast = parse_str("hi {{ name }}").unwrap();
		assert_eq!(ast.nodes.len(), 2);
		assert!(matches!(ast.nodes[1], InkerNode::Interpolation { escape: true, .. }));
	}

	#[test]
	fn raw_interp_escape_false() {
		let ast = parse_str("{{{ html }}}").unwrap();
		assert!(matches!(ast.nodes[0], InkerNode::Interpolation { escape: false, .. }));
	}

	#[test]
	fn slot_placeholder() {
		let ast = parse_str("a{{> body }}b").unwrap();
		assert_eq!(ast.nodes.len(), 3);
		assert!(matches!(ast.nodes[1], InkerNode::Slot(_)));
	}

	#[test]
	fn if_block_assembles() {
		let ast = parse_str("{% if active %}yes{% endif %}").unwrap();
		assert_eq!(ast.nodes.len(), 1);
		match &ast.nodes[0] {
			InkerNode::If { then_nodes, else_nodes, .. } => {
				assert_eq!(then_nodes.len(), 1);
				assert!(else_nodes.is_none());
			}
			_ => panic!("expected If"),
		}
	}

	#[test]
	fn if_else_block() {
		let ast = parse_str("{% if a %}T{% else %}F{% endif %}").unwrap();
		match &ast.nodes[0] {
			InkerNode::If { then_nodes, else_nodes, .. } => {
				assert_eq!(then_nodes.len(), 1);
				assert!(else_nodes.is_some());
			}
			_ => panic!("expected If"),
		}
	}

	#[test]
	fn each_block_assembles() {
		let ast = parse_str("{% each items as i %}{{ i }}{% endeach %}").unwrap();
		match &ast.nodes[0] {
			InkerNode::Each { body_nodes, .. } => {
				assert_eq!(body_nodes.len(), 1);
			}
			_ => panic!("expected Each"),
		}
	}

	#[test]
	fn unclosed_block_errors() {
		let e = parse_str("{% if x %}body").unwrap_err();
		assert_eq!(e.code, ErrorCode::UnclosedBlock);
	}

	#[test]
	fn unmatched_close_errors() {
		let e = parse_str("body{% endif %}").unwrap_err();
		assert_eq!(e.code, ErrorCode::UnmatchedBlockEnd);
	}

	#[test]
	fn mismatched_close_errors() {
		let e = parse_str("{% if a %}{% endeach %}").unwrap_err();
		assert_eq!(e.code, ErrorCode::MismatchedBlockEnd);
	}

	#[test]
	fn layout_first_directive_ok() {
		let ast = parse_str("{% layout 'main' %}body").unwrap();
		assert!(ast.layout.is_some());
		assert_eq!(ast.nodes.len(), 1);
	}

	#[test]
	fn layout_after_content_errors() {
		let e = parse_str("hello {% layout 'main' %}").unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidLayoutPosition);
	}

	#[test]
	fn duplicate_layout_errors() {
		let e = parse_str("{% layout 'main' %}{% layout 'other' %}").unwrap_err();
		assert_eq!(e.code, ErrorCode::DuplicateLayout);
	}

	#[test]
	fn helper_call_site_collected() {
		let tokens = lex("{{ upper(name) }}", &LexOptions::default()).unwrap();
		let opts = ParseOptions {
			template_path: None,
			helpers: {
				let mut s = HashSet::new();
				s.insert("upper".to_string());
				s
			},
		};
		let ast = parse(&tokens, &opts).unwrap();
		assert_eq!(ast.helper_call_sites.len(), 1);
		assert_eq!(ast.helper_call_sites[0].name, "upper");
		assert_eq!(ast.helper_call_sites[0].id, 0);
		assert_eq!(ast.helper_count, 1);
	}

	#[test]
	fn nested_helpers_inner_first_id_order() {
		let tokens = lex("{{ a(b()) }}", &LexOptions::default()).unwrap();
		let mut helpers = HashSet::new();
		helpers.insert("a".to_string());
		helpers.insert("b".to_string());
		let opts = ParseOptions {
			template_path: None,
			helpers,
		};
		let ast = parse(&tokens, &opts).unwrap();
		assert_eq!(ast.helper_call_sites.len(), 2);
		assert_eq!(ast.helper_call_sites[0].id, 0); // b() first (inner)
		assert_eq!(ast.helper_call_sites[0].name, "b");
		assert_eq!(ast.helper_call_sites[1].id, 1); // a() second (outer)
		assert_eq!(ast.helper_call_sites[1].name, "a");
	}
}
