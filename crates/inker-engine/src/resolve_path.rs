//! Path-walk against `serde_json::Value` — mirrors
//! `packages/inker/src/resolvePath.ts` 1:1. Mirrors apply: own-property guard
//! (`Object.hasOwn`), sparse-array hole rejection, label formatting.
//!
//! `serde_json::Value` is the wire format for data crossing the NAPI
//! boundary. JS `Map` / `Set` instances in the data tree are encoded TS-side
//! before crossing (see render.rs for iteration semantics). resolve_path only
//! traverses plain objects and arrays.

use crate::error::{ErrorCode, InkerError};
use crate::parse_path::PathSegment;
use serde_json::Value;

#[derive(Debug, Default, Clone)]
pub struct ResolvePathContext {
	pub template_path: Option<String>,
	pub template_name: Option<String>,
	pub line: Option<u32>,
	pub column: Option<u32>,
	pub expression: Option<String>,
}

fn format_consumed(consumed: &[PathSegment]) -> String {
	let parts: Vec<String> = consumed
		.iter()
		.map(|seg| match seg {
			PathSegment::Index(n) => n.to_string(),
			PathSegment::Key(s) => serde_json::to_string(s).unwrap_or_else(|_| {
				// String serialization is infallible in practice; the unwrap
				// is structural — surface a sane default if a future serde
				// regression breaks it.
				format!("\"{s}\"")
			}),
		})
		.collect();
	format!("[{}]", parts.join(", "))
}

fn full_path_label(path: &[PathSegment]) -> String {
	let mut out = String::new();
	for (i, seg) in path.iter().enumerate() {
		match seg {
			PathSegment::Index(n) => {
				out.push('[');
				out.push_str(&n.to_string());
				out.push(']');
			}
			PathSegment::Key(s) => {
				if i == 0 {
					out.clone_from(s);
				} else {
					out.push('.');
					out.push_str(s);
				}
			}
		}
	}
	out
}

fn err(
	context: &ResolvePathContext,
	path: &[PathSegment],
	msg_tail: String,
) -> InkerError {
	let label = full_path_label(path);
	let message = format!("Unknown identifier '{label}' — {msg_tail}");
	let mut e = InkerError::new(ErrorCode::UnknownIdentifier, message);
	if let (Some(line), Some(col)) = (context.line, context.column) {
		e = e.with_pos(line, col);
	}
	if let Some(name) = &context.template_name {
		e = e.with_template(name.clone());
	}
	e
}

pub fn resolve_path(
	data: &Value,
	path: &[PathSegment],
	context: &ResolvePathContext,
) -> Result<Value, InkerError> {
	let mut current: Value = data.clone();
	let mut consumed: Vec<PathSegment> = Vec::new();

	for (i, segment) in path.iter().enumerate() {
		let is_last = i + 1 == path.len();

		if current.is_null() {
			return Err(err(
				context,
				path,
				format!("got null at {}", format_consumed(&consumed)),
			));
		}

		match segment {
			PathSegment::Index(idx) => {
				let arr = match current.as_array() {
					Some(a) => a,
					None => {
						return Err(err(
							context,
							path,
							format!(
								"numeric index {} against non-array at {}",
								idx,
								format_consumed(&consumed)
							),
						));
					}
				};
				// `*idx as usize` would silently truncate on a 32-bit target; a
				// `try_from` failure means the index exceeds `usize::MAX`, which is
				// necessarily out of range for any in-memory array.
				let idx_usize = match usize::try_from(*idx) {
					Ok(i) => i,
					Err(_) => {
						return Err(err(
							context,
							path,
							format!(
								"index {} out of range (length {}) at {}",
								idx,
								arr.len(),
								format_consumed(&consumed)
							),
						));
					}
				};
				if idx_usize >= arr.len() {
					return Err(err(
						context,
						path,
						format!(
							"index {} out of range (length {}) at {}",
							idx,
							arr.len(),
							format_consumed(&consumed)
						),
					));
				}
				// serde_json's Value::Array doesn't expose sparse holes — the
				// TS sparse-hole guard exists for JS arrays where slots can be
				// uninitialised. JSON round-trips strip the holes (encoded as
				// `null`); we treat explicit-null as a present `null` value and
				// let the next iteration's `is_null()` branch catch it. If the
				// TS-side pre-encodes a sparse hole as a marker (e.g. via the
				// helper pre-resolve walk for fixed arities), that case is
				// caught higher up.
				current = arr[idx_usize].clone();
			}
			PathSegment::Key(key) => {
				let obj = match current.as_object() {
					Some(o) => o,
					None => {
						return Err(err(
							context,
							path,
							format!(
								"string segment '{}' against non-object at {}",
								key,
								format_consumed(&consumed)
							),
						));
					}
				};
				if !obj.contains_key(key) {
					return Err(err(
						context,
						path,
						format!(
							"own property '{}' missing at {}",
							key,
							format_consumed(&consumed)
						),
					));
				}
				current = obj[key].clone();
			}
		}

		consumed.push(segment.clone());

		if is_last {
			return Ok(current);
		}
	}

	Ok(current)
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	#[test]
	fn simple_key() {
		let data = json!({ "name": "alice" });
		let v = resolve_path(
			&data,
			&[PathSegment::Key("name".into())],
			&ResolvePathContext::default(),
		)
		.unwrap();
		assert_eq!(v, json!("alice"));
	}

	#[test]
	fn nested_key() {
		let data = json!({ "user": { "name": "bob" } });
		let v = resolve_path(
			&data,
			&[
				PathSegment::Key("user".into()),
				PathSegment::Key("name".into()),
			],
			&ResolvePathContext::default(),
		)
		.unwrap();
		assert_eq!(v, json!("bob"));
	}

	#[test]
	fn array_index() {
		let data = json!({ "items": [10, 20, 30] });
		let v = resolve_path(
			&data,
			&[PathSegment::Key("items".into()), PathSegment::Index(1)],
			&ResolvePathContext::default(),
		)
		.unwrap();
		assert_eq!(v, json!(20));
	}

	#[test]
	fn missing_key_errors() {
		let data = json!({ "a": 1 });
		let e = resolve_path(
			&data,
			&[PathSegment::Key("b".into())],
			&ResolvePathContext::default(),
		)
		.unwrap_err();
		assert_eq!(e.code, ErrorCode::UnknownIdentifier);
	}

	#[test]
	fn index_oob_errors() {
		let data = json!({ "items": [1, 2] });
		let e = resolve_path(
			&data,
			&[PathSegment::Key("items".into()), PathSegment::Index(5)],
			&ResolvePathContext::default(),
		)
		.unwrap_err();
		assert_eq!(e.code, ErrorCode::UnknownIdentifier);
	}

	#[test]
	fn string_segment_against_array_errors() {
		let data = json!({ "items": [1, 2] });
		let e = resolve_path(
			&data,
			&[
				PathSegment::Key("items".into()),
				PathSegment::Key("name".into()),
			],
			&ResolvePathContext::default(),
		)
		.unwrap_err();
		assert_eq!(e.code, ErrorCode::UnknownIdentifier);
	}

	#[test]
	fn null_value_errors_on_next_segment() {
		let data = json!({ "user": null });
		let e = resolve_path(
			&data,
			&[
				PathSegment::Key("user".into()),
				PathSegment::Key("name".into()),
			],
			&ResolvePathContext::default(),
		)
		.unwrap_err();
		assert_eq!(e.code, ErrorCode::UnknownIdentifier);
	}
}
