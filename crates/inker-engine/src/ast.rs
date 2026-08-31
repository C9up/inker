//! Shared AST types — used by `parse_block_tag.rs` (which emits them) and
//! `parse.rs` (which assembles them into the final `InkerAst`). Lives in its
//! own module to break the otherwise-cyclic dependency between block-tag
//! parsing and the top-level parser.

use crate::parse_expression::Expression;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
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
    /// Template-local binding: `@let(x = <expr>)` or a destructuring pattern
    /// `@let({ a, b } = obj)` / `@let([x, ...rest] = pair)` (Edge parity, 62-2).
    /// The value(s) are added to the render scope for every SIBLING node that
    /// follows it in the same node list (block-scoped, like `each`). The Node
    /// renderer evaluates `source` in V8 with helpers + scope in scope. When
    /// `destructure` is true, `name` holds the verbatim pattern (`{ a, b }`) and
    /// `names` holds the bound identifiers extracted + validated at parse time
    /// (proto-pollution / reserved-word / shape guards, parity with the simple
    /// `@let` path); the Node side folds them into the scope.
    Let {
        name: String,
        expression: Expression,
        source: String,
        destructure: bool,
        names: Vec<String>,
        line: u32,
        column: u32,
    },
    Component(ComponentNode),
    /// `@section('name')…@endsection` — a named layout section. In a layout it
    /// is a yield point (with default content); in a child it fills the layout's
    /// matching yield. The Node renderer resolves the role by position.
    Section {
        name: String,
        body_nodes: Vec<InkerNode>,
        line: u32,
        column: u32,
    },
    /// `@super` — inside a child section, yields the layout's default content
    /// for the enclosing section.
    Super {
        line: u32,
        column: u32,
    },
    /// `@eval(expr)` — evaluate `source` for its side effects, emit nothing.
    Eval {
        source: String,
        line: u32,
        column: u32,
    },
    /// `@dump(expr)` — pretty-print `source`'s value for debugging. `@dd(expr)`
    /// is the same node with `die` set: it prints, then aborts the render
    /// (Adonis's dumper plugin registers both on Edge).
    Dump {
        source: String,
        die: bool,
        line: u32,
        column: u32,
    },
    /// `@assign(x = expr)` — re-assign an EXISTING binding, as opposed to `@let`
    /// which introduces a new one. `target` is the assignment's left-hand side
    /// (a bare identifier or a member path), `source` the whole assignment.
    Assign {
        target: String,
        source: String,
        line: u32,
        column: u32,
    },
    /// `@inject(obj)` — merge `obj` into the enclosing component's `$context`,
    /// which nested components read. Errors outside a component scope.
    Inject {
        source: String,
        line: u32,
        column: u32,
    },
    /// `@debugger` — a breakpoint for `node --inspect`. Takes no arguments.
    Debugger {
        line: u32,
        column: u32,
    },
    /// `@newError(message, filename?, line?, col?)` — raise from a template,
    /// pointing at a chosen position (typically `$caller`'s, so a component's
    /// misuse blames the call site rather than the component).
    NewError {
        source: String,
        line: u32,
        column: u32,
    },
    /// `@stack('name')` — a named placeholder that `@pushTo` fills. `source` is
    /// an expression (Edge allows any non-sequence expression, not just a
    /// literal), evaluated to the stack name at render time.
    Stack {
        source: String,
        line: u32,
        column: u32,
    },
    /// `@pushTo('name')…@endpushTo` — render the body and append it to a stack.
    /// With `once`, a given call site contributes only its first render
    /// (`@pushOnceTo`), which is how a component ships its script tag once no
    /// matter how many times it is used.
    PushTo {
        source: String,
        body_nodes: Vec<InkerNode>,
        once: bool,
        line: u32,
        column: u32,
    },
    /// `@<name>(args)` — a runtime-registered custom tag (Edge `registerTag`).
    /// The Node renderer evaluates `args_source` and calls the handler for `name`.
    /// `body_nodes` is the block body for a tag registered with `block: true`
    /// (empty for an inline tag, and for the self-closed `@!<name>` form).
    CustomTag {
        name: String,
        args_source: String,
        body_nodes: Vec<InkerNode>,
        line: u32,
        column: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LayoutNode {
    pub name: String,
    pub raw: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PartialNode {
    pub name: String,
    pub raw: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlotNode {
    pub name: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IfCondition {
    pub expression: Expression,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ComponentArg {
    pub key: String,
    pub value: Expression,
    pub source: String,
}

/// A `@slot('name')…@endslot` block captured inside a component
/// invocation body. Its `nodes` render in the CALLER's scope and are injected
/// at the matching `{{> name }}` placeholder in the component template.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NamedSlot {
    pub name: String,
    pub nodes: Vec<InkerNode>,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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
