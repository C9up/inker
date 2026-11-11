//! `inker-engine` — pure-Rust lex / parse hot path for the Inker
//! templating engine. Designed to be embedded by `inker-engine-napi` for the
//! Node.js boundary; the engine itself has zero `napi` deps so it stays
//! reusable from any Rust caller.
//!
//! The engine lexes and parses; the Node renderer evaluates each expression's
//! verbatim source in V8 and does all the escaping, so nothing here renders.

pub mod ast;
pub mod error;
pub mod identifiers;
mod js_scan;
pub mod lex;
pub mod parse;
pub mod parse_block_tag;
pub mod parse_expression;
pub mod parse_path;

pub use error::{ErrorCode, InkerError};
pub use parse::{parse, InkerAst, ParseOptions};
