//! Identifier denylists shared between the block-tag parser (each-binding +
//! component-arg-key validation) and the expression parser (object-literal
//! key validation).
//!
//! Mirrors `packages/inker/src/identifierGuards.ts` 1:1 — when one moves, the
//! other must move with it.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashSet;

/// Keys whose own-property assignment could shadow `Object.prototype` methods
/// or invoke `Object.create` semantics in surprising ways on the JS side. The
/// gate is defence-in-depth: rendered output is structural HTML, but template
/// authors cannot reason about the renderer's storage shape.
pub static PROTOTYPE_POLLUTION_KEYS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
	let mut s = HashSet::new();
	s.insert("__proto__");
	s.insert("constructor");
	s.insert("prototype");
	s
});

/// Names blocked in `{% each items as <name> %}` and destructured-pair
/// positions — collide with Inker grammar keywords or JS reserved words. The
/// block is per-position; paths can use these names safely.
pub static RESERVED_BINDING_NAMES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
	let mut s = HashSet::new();
	for name in [
		"as",
		"if",
		"else",
		"each",
		"do",
		"for",
		"while",
		"let",
		"const",
		"var",
		"return",
		"function",
		"class",
		"new",
		"this",
		"super",
		"null",
		"undefined",
		"true",
		"false",
	] {
		s.insert(name);
	}
	s
});

/// `[a-zA-Z_$][a-zA-Z0-9_$]*` — the canonical "JS identifier shape" used for
/// helper names, binding names, and object-literal keys.
pub static IDENTIFIER_RE: Lazy<Regex> = Lazy::new(|| {
	Regex::new(r"^[a-zA-Z_$][a-zA-Z0-9_$]*$").expect("static regex compiles")
});

pub fn is_valid_identifier(name: &str) -> bool {
	IDENTIFIER_RE.is_match(name)
}

pub fn is_prototype_pollution_key(name: &str) -> bool {
	PROTOTYPE_POLLUTION_KEYS.contains(name)
}

pub fn is_reserved_binding(name: &str) -> bool {
	RESERVED_BINDING_NAMES.contains(name)
}
