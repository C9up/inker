//! `inker-engine` — pure-Rust lex / parse / render hot path for the Inker
//! templating engine. Designed to be embedded by `inker-engine-napi` for the
//! Node.js boundary; the engine itself has zero `napi` deps so it stays
//! reusable from any Rust caller.
//!
//! Story 55.1 lands the scaffold + leaf modules (escape / error / identifiers).
//! Subsequent commits in the same story port `lex`, `parse_path`,
//! `parse_expression`, `parse_block_tag`, `parse`, `resolve_path`, `render`.

pub mod error;
pub mod escape;
pub mod identifiers;
pub mod lex;
pub mod ast;
pub mod collect;
pub mod parse;
pub mod parse_block_tag;
pub mod parse_expression;
pub mod parse_path;
pub mod render;
pub mod resolve_path;

pub use collect::{collect_invocations, Invocation};
pub use error::{ErrorCode, InkerError};
pub use escape::{escape_attr, escape_text};
pub use parse::{parse, InkerAst, ParseOptions};
pub use render::{render, RenderContext, ResolvedHelperValue};
