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
	/// Template-local binding: `@let(x = <member/literal/operator expr>)`.
	/// The value is added to the render scope for every SIBLING node that
	/// follows it in the same node list (block-scoped, like `each`). Helper
	/// calls in the expression are rejected by the restricted-grammar
	/// `eval_pure` (helpers resolve only at interpolation / component-arg
	/// positions), so `let` stays inside the pure-expression grammar.
	Let {
		name: String,
		expression: Expression,
		source: String,
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
	/// Edge `@each((value, index) in iterable)` — binds the element to `item`
	/// and its position to `index` (numeric index for arrays, property key for
	/// objects). Distinct from `Destructured`, which iterates array-of-pairs.
	Indexed {
		item: String,
		index: String,
	},
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComponentArg {
	pub key: String,
	pub value: Expression,
	pub source: String,
}

/// A `@slot('name')…@endslot` block captured inside a component
/// invocation body. Its `nodes` render in the CALLER's scope and are injected
/// at the matching `{{> name }}` placeholder in the component template.
#[derive(Debug, Clone, PartialEq)]
pub struct NamedSlot {
	pub name: String,
	pub nodes: Vec<InkerNode>,
	pub line: u32,
	pub column: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComponentNode {
	pub name: String,
	pub args: Vec<ComponentArg>,
	/// Default (`body`) slot content — the block body outside any
	/// `@slot()`. Empty for the self-closing `@component()` form.
	pub body_nodes: Vec<InkerNode>,
	/// Named `@slot('x')` blocks captured from the invocation body.
	pub named_slots: Vec<NamedSlot>,
	pub raw: String,
	pub line: u32,
	pub column: u32,
}
