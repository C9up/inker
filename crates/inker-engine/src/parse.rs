//! Top-level parser — mirrors `packages/inker/src/parse.ts` 1:1.
//!
//! Consumes the `Vec<Token>` from `lex::lex`, dispatches block tags through
//! `parse_block_tag::parse_block_tag`, balances `@if()` / `@each()` /
//! `@else` / `@endif` / `@endeach` via a frame stack, and
//! assembles the final `InkerAst`. Also collects every helper call-site for
//! the ADR-007 TS-side pre-resolve walk (AC6).

use crate::ast::{
	ComponentArg, ComponentNode, EachBinding, IfCondition, InkerNode, LayoutNode,
	NamedSlot, SlotNode,
};
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
	/// Runtime-registered custom tag names (Edge `registerTag`).
	pub custom_tags: HashSet<String>,
}

fn is_whitespace_only(value: &str) -> bool {
	value
		.chars()
		.all(|c| c == ' ' || c == '\t' || c == '\n' || c == '\r')
}

/// One `if` / `elseif` arm of an `If` frame. Folded (innermost-last) into a
/// chain of binary `InkerNode::If` at close so render / collect / napi keep
/// seeing the simple two-way `If` shape.
struct IfBranch {
	condition: IfCondition,
	nodes: Vec<InkerNode>,
	line: u32,
	column: u32,
}

/// A `@slot('name')` currently being captured inside a component frame.
struct SlotBuild {
	name: String,
	nodes: Vec<InkerNode>,
	line: u32,
	column: u32,
}

enum BlockFrame {
	If {
		line: u32,
		column: u32,
		branches: Vec<IfBranch>,
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
	Component {
		line: u32,
		column: u32,
		name: String,
		args: Vec<ComponentArg>,
		raw: String,
		body_nodes: Vec<InkerNode>,
		named_slots: Vec<NamedSlot>,
		active_slot: Option<SlotBuild>,
	},
	Section {
		line: u32,
		column: u32,
		name: String,
		body_nodes: Vec<InkerNode>,
	},
}

impl BlockFrame {
	fn active_mut(&mut self) -> &mut Vec<InkerNode> {
		match self {
			BlockFrame::If {
				branches,
				else_nodes,
				in_else,
				..
			} => {
				if *in_else {
					else_nodes.get_or_insert_with(Vec::new)
				} else {
					&mut branches
						.last_mut()
						.expect("If frame always has >= 1 branch")
						.nodes
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
			BlockFrame::Component {
				body_nodes,
				active_slot,
				..
			} => match active_slot {
				Some(slot) => &mut slot.nodes,
				None => body_nodes,
			},
			BlockFrame::Section { body_nodes, .. } => body_nodes,
		}
	}

	/// Lower-case opening directive keyword, for `@...` error messages.
	fn open_keyword(&self) -> &'static str {
		match self {
			BlockFrame::If { .. } => "if",
			BlockFrame::Each { .. } => "each",
			BlockFrame::Component { .. } => "component",
			BlockFrame::Section { .. } => "section",
		}
	}

	fn line(&self) -> u32 {
		match self {
			BlockFrame::If { line, .. }
			| BlockFrame::Each { line, .. }
			| BlockFrame::Component { line, .. }
			| BlockFrame::Section { line, .. } => *line,
		}
	}

	fn column(&self) -> u32 {
		match self {
			BlockFrame::If { column, .. }
			| BlockFrame::Each { column, .. }
			| BlockFrame::Component { column, .. }
			| BlockFrame::Section { column, .. } => *column,
		}
	}
}

/// Fold an `If` frame's `if`/`elseif` branches plus optional `else` into a
/// chain of two-way `InkerNode::If` (innermost `else` last). With no `elseif`
/// this yields exactly the original single `If { then, else }` shape.
fn fold_if_branches(
	branches: Vec<IfBranch>,
	else_nodes: Option<Vec<InkerNode>>,
) -> InkerNode {
	let mut acc: Option<Vec<InkerNode>> = else_nodes;
	let mut node: Option<InkerNode> = None;
	for branch in branches.into_iter().rev() {
		let if_node = InkerNode::If {
			condition: branch.condition,
			then_nodes: branch.nodes,
			else_nodes: acc.take(),
			line: branch.line,
			column: branch.column,
		};
		acc = Some(vec![if_node.clone()]);
		node = Some(if_node);
	}
	node.expect("If frame always has >= 1 branch")
}

/// Cheap leading-keyword sniff on a block tag's raw inner (already trimmed by
/// the lexer) — used only for the component/endcomponent lookahead.
fn block_tag_keyword(raw: &str) -> &str {
	let trimmed = raw.trim_start();
	let end = trimmed
		.find(|c: char| c.is_whitespace() || c == '{')
		.unwrap_or(trimmed.len());
	&trimmed[..end]
}

/// Decide whether the `@component()` at `tokens[start]` opens a block (has a
/// matching `@endcomponent`) or is the self-closing inline form. Treats
/// component/endcomponent as balanced pairs: the nearest unpaired
/// `endcomponent` closes this component. No matching end ⇒ self-closing, so
/// legacy inline `@component()` (no endcomponent) stays backward compatible.
fn component_opens_block(tokens: &[Token], start: usize) -> bool {
	let mut depth: i32 = 0;
	let mut i = start + 1;
	while i < tokens.len() {
		if let Token::BlockTag { raw, .. } = &tokens[i] {
			match block_tag_keyword(raw) {
				"component" => depth += 1,
				"endcomponent" => {
					if depth == 0 {
						return true;
					}
					depth -= 1;
				}
				_ => {}
			}
		}
		i += 1;
	}
	false
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
		// `Raw` is helper-free by construction (see `parse_expression::raw_fallback`).
		Expression::Literal { .. } | Expression::Path { .. } | Expression::Raw { .. } => {}
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
			for n in &c.body_nodes {
				collect_helpers_in_node(n, out);
			}
			for slot in &c.named_slots {
				for n in &slot.nodes {
					collect_helpers_in_node(n, out);
				}
			}
		}
		InkerNode::Let { expression, .. } => {
			collect_helpers_in_expr(expression, out);
		}
		InkerNode::Section { body_nodes, .. } => {
			for n in body_nodes {
				collect_helpers_in_node(n, out);
			}
		}
		InkerNode::Text { .. }
		| InkerNode::Layout(_)
		| InkerNode::Partial(_)
		| InkerNode::Slot(_)
		| InkerNode::Super { .. }
		| InkerNode::Eval { .. }
		| InkerNode::Dump { .. }
		| InkerNode::CustomTag { .. } => {}
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

	for (token_index, token) in tokens.iter().enumerate() {
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
					custom_tags: options.custom_tags.clone(),
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
									"@layout must be the first directive in the template (got at line {}, column {} inside a block)",
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
									"@layout declared twice (first at line {sl_line}, second at line {})",
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
									"@layout must be the first directive in the template (got at line {}, column {} after non-whitespace content)",
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
						if component_opens_block(tokens, token_index) {
							open_blocks.push(BlockFrame::Component {
								line: component_node.line,
								column: component_node.column,
								name: component_node.name,
								args: component_node.args,
								raw: component_node.raw,
								body_nodes: Vec::new(),
								named_slots: Vec::new(),
								active_slot: None,
							});
							if open_blocks.len() == 1 {
								seen_non_whitespace_content = true;
							}
						} else {
							push_node(
								InkerNode::Component(component_node),
								&mut root_nodes,
								&mut open_blocks,
							);
							if open_blocks.is_empty() {
								seen_non_whitespace_content = true;
							}
						}
					}
					ParsedBlockTag::OpenSlot {
						name,
						line: pl,
						column: pc,
					} => {
						let top = match open_blocks.last_mut() {
							Some(t) => t,
							None => {
								return Err(make_err(
									ErrorCode::UnmatchedBlockEnd,
									format!("@slot('{name}') outside of a @component() block (at line {pl}, column {pc})"),
									pl,
									pc,
									template_path,
								));
							}
						};
						match top {
							BlockFrame::Component {
								active_slot,
								named_slots,
								..
							} => {
								if active_slot.is_some() {
									return Err(make_err(
										ErrorCode::UnmatchedBlockEnd,
										format!("Nested @slot('{name}') — close the previous slot with @endslot first (at line {pl}, column {pc})"),
										pl,
										pc,
										template_path,
									));
								}
								if named_slots.iter().any(|s| s.name == name) {
									return Err(make_err(
										ErrorCode::InvalidExpression,
										format!("Duplicate slot name '{name}' in the same @component() block (at line {pl}, column {pc})"),
										pl,
										pc,
										template_path,
									));
								}
								*active_slot = Some(SlotBuild {
									name,
									nodes: Vec::new(),
									line: pl,
									column: pc,
								});
							}
							_ => {
								return Err(make_err(
									ErrorCode::UnmatchedBlockEnd,
									format!("@slot('{name}') must be a direct child of a @component() block (at line {pl}, column {pc})"),
									pl,
									pc,
									template_path,
								));
							}
						}
					}
					ParsedBlockTag::CloseSlot {
						line: pl,
						column: pc,
					} => {
						let top = match open_blocks.last_mut() {
							Some(t) => t,
							None => {
								return Err(make_err(
									ErrorCode::UnmatchedBlockEnd,
									format!("@endslot with no open @slot (at line {pl}, column {pc})"),
									pl,
									pc,
									template_path,
								));
							}
						};
						match top {
							BlockFrame::Component { active_slot, named_slots, .. } => {
								match active_slot.take() {
									Some(slot) => named_slots.push(NamedSlot {
										name: slot.name,
										nodes: slot.nodes,
										line: slot.line,
										column: slot.column,
									}),
									None => {
										return Err(make_err(
											ErrorCode::UnmatchedBlockEnd,
											format!("@endslot with no open @slot (at line {pl}, column {pc})"),
											pl,
											pc,
											template_path,
										));
									}
								}
							}
							_ => {
								return Err(make_err(
									ErrorCode::UnmatchedBlockEnd,
									format!("@endslot with no open @slot (at line {pl}, column {pc})"),
									pl,
									pc,
									template_path,
								));
							}
						}
					}
					ParsedBlockTag::CloseComponent {
						line: pl,
						column: pc,
					} => {
						let top = match open_blocks.last() {
							Some(t) => t,
							None => {
								return Err(make_err(
									ErrorCode::UnmatchedBlockEnd,
									format!("@endcomponent with no open @component() (at line {pl}, column {pc})"),
									pl,
									pc,
									template_path,
								));
							}
						};
						if !matches!(top, BlockFrame::Component { .. }) {
							let open_kw = top.open_keyword();
							let top_line = top.line();
							let top_col = top.column();
							return Err(make_err(
								ErrorCode::MismatchedBlockEnd,
								format!("@endcomponent does not match open @{open_kw} (open at line {top_line}, column {top_col}; close at line {pl}, column {pc})"),
								pl,
								pc,
								template_path,
							));
						}
						let frame = open_blocks.pop().expect("checked above");
						if let BlockFrame::Component {
							line,
							column,
							name,
							args,
							raw,
							body_nodes,
							named_slots,
							active_slot,
						} = frame
						{
							if active_slot.is_some() {
								return Err(make_err(
									ErrorCode::UnclosedBlock,
									format!("@slot was not closed with @endslot before @endcomponent (at line {pl}, column {pc})"),
									pl,
									pc,
									template_path,
								));
							}
							push_node(
								InkerNode::Component(ComponentNode {
									name,
									args,
									body_nodes,
									named_slots,
									raw,
									line,
									column,
								}),
								&mut root_nodes,
								&mut open_blocks,
							);
						}
					}
					ParsedBlockTag::Let {
						name,
						expression,
						source,
						line: pl,
						column: pc,
					} => {
						push_node(
							InkerNode::Let {
								name,
								expression,
								source,
								line: pl,
								column: pc,
							},
							&mut root_nodes,
							&mut open_blocks,
						);
						if open_blocks.is_empty() {
							seen_non_whitespace_content = true;
						}
					}
					ParsedBlockTag::IncludeIf {
						condition,
						partial,
						line: pl,
						column: pc,
					} => {
						// `@includeIf(cond, 'name')` desugars to
						// `@if(cond)@include('name')@endif`, reusing the
						// existing If + Partial render / collect / compose machinery.
						push_node(
							InkerNode::If {
								condition,
								then_nodes: vec![InkerNode::Partial(partial)],
								else_nodes: None,
								line: pl,
								column: pc,
							},
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
							branches: vec![IfBranch {
								condition,
								nodes: Vec::new(),
								line: pl,
								column: pc,
							}],
							else_nodes: None,
							in_else: false,
						});
						if open_blocks.len() == 1 {
							seen_non_whitespace_content = true;
						}
					}
					ParsedBlockTag::ElseIf {
						condition,
						line: pl,
						column: pc,
					} => {
						let top = match open_blocks.last_mut() {
							Some(t) => t,
							None => {
								return Err(make_err(
									ErrorCode::UnmatchedBlockEnd,
									format!("@elseif() with no open @if (at line {pl}, column {pc})"),
									pl,
									pc,
									template_path,
								));
							}
						};
						match top {
							BlockFrame::If {
								branches,
								in_else,
								..
							} => {
								if *in_else {
									return Err(make_err(
										ErrorCode::InvalidExpression,
										format!("@elseif() after @else in the same @if block (at line {pl}, column {pc})"),
										pl,
										pc,
										template_path,
									));
								}
								branches.push(IfBranch {
									condition,
									nodes: Vec::new(),
									line: pl,
									column: pc,
								});
							}
							other => {
								let open_kw = other.open_keyword();
								return Err(make_err(
									ErrorCode::InvalidExpression,
									format!("@elseif() only valid inside @if, not @{open_kw} (at line {pl}, column {pc})"),
									pl,
									pc,
									template_path,
								));
							}
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
					ParsedBlockTag::OpenSection {
						name,
						line: pl,
						column: pc,
					} => {
						open_blocks.push(BlockFrame::Section {
							line: pl,
							column: pc,
							name,
							body_nodes: Vec::new(),
						});
						if open_blocks.len() == 1 {
							seen_non_whitespace_content = true;
						}
					}
					ParsedBlockTag::Super {
						line: pl,
						column: pc,
					} => {
						push_node(
							InkerNode::Super { line: pl, column: pc },
							&mut root_nodes,
							&mut open_blocks,
						);
						if open_blocks.len() == 1 {
							seen_non_whitespace_content = true;
						}
					}
					ParsedBlockTag::Eval {
						source,
						line: pl,
						column: pc,
					} => {
						push_node(
							InkerNode::Eval {
								source,
								line: pl,
								column: pc,
							},
							&mut root_nodes,
							&mut open_blocks,
						);
						if open_blocks.len() == 1 {
							seen_non_whitespace_content = true;
						}
					}
					ParsedBlockTag::Dump {
						source,
						line: pl,
						column: pc,
					} => {
						push_node(
							InkerNode::Dump {
								source,
								line: pl,
								column: pc,
							},
							&mut root_nodes,
							&mut open_blocks,
						);
						if open_blocks.len() == 1 {
							seen_non_whitespace_content = true;
						}
					}
					ParsedBlockTag::CustomTag {
						name,
						args_source,
						line: pl,
						column: pc,
					} => {
						push_node(
							InkerNode::CustomTag {
								name,
								args_source,
								line: pl,
								column: pc,
							},
							&mut root_nodes,
							&mut open_blocks,
						);
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
										"@else with no open @if or @each (at line {pl}, column {pc})"
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
							BlockFrame::Component { .. } | BlockFrame::Section { .. } => {
								return Err(make_err(
									ErrorCode::UnmatchedBlockEnd,
									format!(
										"@else inside a @{} block — 'else' is only valid in @if / @each (at line {pl}, column {pc})",
										top.open_keyword()
									),
									pl,
									pc,
									template_path,
								));
							}
						};
						if already {
							let kw = match top {
								BlockFrame::If { .. } => "if",
								BlockFrame::Each { .. } => "each",
								BlockFrame::Component { .. } => "component",
								BlockFrame::Section { .. } => "section",
							};
							let frame_line = top.line();
							return Err(make_err(
								ErrorCode::InvalidExpression,
								format!(
									"Multiple @else clauses in the same @{kw} block (open at line {frame_line}, second else at line {pl})"
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
							BlockFrame::Component { .. } | BlockFrame::Section { .. } => {}
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
									BlockClosesKind::Section => "endsection",
								};
								return Err(make_err(
									ErrorCode::UnmatchedBlockEnd,
									format!(
										"@{kw} with no open block (at line {pl}, column {pc})"
									),
									pl,
									pc,
									template_path,
								));
							}
						};
						let matches_close = match top {
							BlockFrame::If { .. } => closes == BlockClosesKind::If,
							BlockFrame::Each { .. } => closes == BlockClosesKind::Each,
							BlockFrame::Section { .. } => closes == BlockClosesKind::Section,
							BlockFrame::Component { .. } => false,
						};
						if !matches_close {
							let open_kw = top.open_keyword();
							let close_kw = match closes {
								BlockClosesKind::If => "endif",
								BlockClosesKind::Each => "endeach",
								BlockClosesKind::Section => "endsection",
							};
							let top_line = top.line();
							let top_col = top.column();
							return Err(make_err(
								ErrorCode::MismatchedBlockEnd,
								format!(
									"@{close_kw} does not match open @{open_kw} (open at line {top_line}, column {top_col}; close at line {pl}, column {pc})"
								),
								pl,
								pc,
								template_path,
							));
						}
						let frame = open_blocks.pop().expect("checked above");
						let node = match frame {
							BlockFrame::If {
								branches,
								else_nodes,
								..
							} => fold_if_branches(branches, else_nodes),
							BlockFrame::Component { .. } => unreachable!(
								"@endcomponent is closed by the CloseComponent arm, never the generic if/each close"
							),
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
							BlockFrame::Section {
								name,
								body_nodes,
								line,
								column,
							} => InkerNode::Section {
								name,
								body_nodes,
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
		let kw_lower = top.open_keyword();
		return Err(make_err(
			ErrorCode::UnclosedBlock,
			format!(
				"@{kw_lower} started at line {}, column {} was never closed",
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
		let ast = parse_str("@if(active)yes@endif").unwrap();
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
		let ast = parse_str("@if(a)T@else\nF@endif").unwrap();
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
		let ast = parse_str("@each(i in items){{ i }}@endeach").unwrap();
		match &ast.nodes[0] {
			InkerNode::Each { body_nodes, .. } => {
				assert_eq!(body_nodes.len(), 1);
			}
			_ => panic!("expected Each"),
		}
	}

	#[test]
	fn unclosed_block_errors() {
		let e = parse_str("@if(x)body").unwrap_err();
		assert_eq!(e.code, ErrorCode::UnclosedBlock);
	}

	#[test]
	fn unmatched_close_errors() {
		let e = parse_str("body@endif").unwrap_err();
		assert_eq!(e.code, ErrorCode::UnmatchedBlockEnd);
	}

	#[test]
	fn mismatched_close_errors() {
		let e = parse_str("@if(a)@endeach").unwrap_err();
		assert_eq!(e.code, ErrorCode::MismatchedBlockEnd);
	}

	#[test]
	fn layout_first_directive_ok() {
		let ast = parse_str("@layout('main')body").unwrap();
		assert!(ast.layout.is_some());
		assert_eq!(ast.nodes.len(), 1);
	}

	#[test]
	fn layout_after_content_errors() {
		let e = parse_str("hello @layout('main')").unwrap_err();
		assert_eq!(e.code, ErrorCode::InvalidLayoutPosition);
	}

	#[test]
	fn duplicate_layout_errors() {
		let e = parse_str("@layout('main')@layout('other')").unwrap_err();
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
			custom_tags: HashSet::new(),
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
			custom_tags: HashSet::new(),
		};
		let ast = parse(&tokens, &opts).unwrap();
		assert_eq!(ast.helper_call_sites.len(), 2);
		assert_eq!(ast.helper_call_sites[0].id, 0); // b() first (inner)
		assert_eq!(ast.helper_call_sites[0].name, "b");
		assert_eq!(ast.helper_call_sites[1].id, 1); // a() second (outer)
		assert_eq!(ast.helper_call_sites[1].name, "a");
	}

	#[test]
	fn custom_tag_is_inert_without_registration() {
		// `@svg(...)` with no registered tag is plain text — the lexer never
		// treats an unknown `@word` as a block tag (Edge parity).
		let tokens = lex("@svg('x')", &LexOptions::default()).unwrap();
		let ast = parse(&tokens, &ParseOptions::default()).unwrap();
		assert_eq!(ast.nodes.len(), 1);
		assert!(matches!(&ast.nodes[0], InkerNode::Text { value } if value == "@svg('x')"));
	}

	#[test]
	fn registered_custom_tag_parses_to_custom_tag_node() {
		let mut custom_tags = HashSet::new();
		custom_tags.insert("svg".to_string());
		let lex_opts = LexOptions {
			template_path: None,
			custom_tags: custom_tags.clone(),
		};
		let tokens = lex("@svg('user', { class: size })", &lex_opts).unwrap();
		let opts = ParseOptions {
			template_path: None,
			helpers: HashSet::new(),
			custom_tags,
		};
		let ast = parse(&tokens, &opts).unwrap();
		assert_eq!(ast.nodes.len(), 1);
		match &ast.nodes[0] {
			InkerNode::CustomTag { name, args_source, .. } => {
				assert_eq!(name, "svg");
				// The block-tag lexer strips the outer parens; args survive verbatim.
				assert_eq!(args_source, "'user', { class: size }");
			}
			other => panic!("expected CustomTag node, got {other:?}"),
		}
	}
}
