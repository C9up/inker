//! Shared AST types — used by `parse_block_tag.rs` (which emits them) and
//! `parse.rs` (which assembles them into the final `InkerAst`). Lives in its
//! own module to break the otherwise-cyclic dependency between block-tag
//! parsing and the top-level parser.

use crate::parse_expression::Expression;

#[derive(Debug, Clone, PartialEq)]
pub enum InkerNode {
	Text {
		value: String,
	},
	Interpolation {
		expression: Expression,
		escape: bool,
		source: String,
		line: u32,
		column: u32,
	},
	Layout(LayoutNode),
	Partial(PartialNode),
	Slot(SlotNode),
	If {
		condition: IfCondition,
		then_nodes: Vec<InkerNode>,
		else_nodes: Option<Vec<InkerNode>>,
		line: u32,
		column: u32,
	},
	Each {
		iterable: Expression,
		iterable_source: String,
		binding: EachBinding,
		body_nodes: Vec<InkerNode>,
		else_nodes: Option<Vec<InkerNode>>,
		line: u32,
		column: u32,
	},
	Component(ComponentNode),
}

#[derive(Debug, Clone, PartialEq)]
pub struct LayoutNode {
	pub name: String,
	pub raw: String,
	pub line: u32,
	pub column: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PartialNode {
	pub name: String,
	pub raw: String,
	pub line: u32,
	pub column: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SlotNode {
	pub name: String,
	pub line: u32,
	pub column: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IfCondition {
	pub expression: Expression,
	pub source: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EachBinding {
	Single(String),
	Destructured([String; 2]),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComponentArg {
	pub key: String,
	pub value: Expression,
	pub source: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComponentNode {
	pub name: String,
	pub args: Vec<ComponentArg>,
	pub raw: String,
	pub line: u32,
	pub column: u32,
}
