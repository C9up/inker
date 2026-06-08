// PATTERN: copy-and-rename for 55.2/55.3/55.4 — Rust hot-path packages.
// Story 55.1 §AC7 freezes the per-package duplication of this module as an
// explicit invariant of the agnostic-package contract. Story 55.5 (extract
// `c9up-escape`) was dismissed 2026-05-29 — every package owns its escape.
//
// Char map is byte-identical to `packages/inker/src/render.ts:escapeHtml`:
//   &  -> &amp;
//   <  -> &lt;
//   >  -> &gt;
//   "  -> &quot;
//   '  -> &#39;
//   `  -> &#96;
//   U+2028 -> &#x2028;
//   U+2029 -> &#x2029;
//
// `escape_text` and `escape_attr` currently apply the same map (the TS today
// has `escapeAttr === escapeHtml`). The two-function split is structural — kept
// for future attr-context divergence not in 55.1 scope.

/// HTML-text-context escape — replaces the 8 chars listed above.
pub fn escape_text(s: &str) -> String {
	escape_inner(s)
}

/// HTML-attribute-context escape. Same byte mapping as [`escape_text`] today;
/// preserved as a distinct entry point so future attr-only divergence has a
/// home.
pub fn escape_attr(s: &str) -> String {
	escape_inner(s)
}

fn escape_inner(s: &str) -> String {
	let mut out = String::with_capacity(s.len() + 16);
	for ch in s.chars() {
		match ch {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			'"' => out.push_str("&quot;"),
			'\'' => out.push_str("&#39;"),
			'`' => out.push_str("&#96;"),
			'\u{2028}' => out.push_str("&#x2028;"),
			'\u{2029}' => out.push_str("&#x2029;"),
			_ => out.push(ch),
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn passes_through_ascii_safe() {
		assert_eq!(escape_text("hello world 123"), "hello world 123");
	}

	#[test]
	fn ampersand_first_to_avoid_double_encoding() {
		assert_eq!(escape_text("&amp;"), "&amp;amp;");
	}

	#[test]
	fn angle_brackets() {
		assert_eq!(escape_text("<script>"), "&lt;script&gt;");
	}

	#[test]
	fn double_quote_to_quot() {
		assert_eq!(escape_text("\"x\""), "&quot;x&quot;");
	}

	#[test]
	fn single_quote_to_numeric_entity() {
		assert_eq!(escape_text("'x'"), "&#39;x&#39;");
	}

	#[test]
	fn backtick_to_numeric_entity() {
		// Backtick can become an attribute delimiter in some legacy parsers —
		// OWASP / Google recommendation is to escape it. Pinning the byte.
		assert_eq!(escape_text("`x`"), "&#96;x&#96;");
	}

	#[test]
	fn ls_ps_line_separators() {
		assert_eq!(escape_text("\u{2028}"), "&#x2028;");
		assert_eq!(escape_text("\u{2029}"), "&#x2029;");
	}

	#[test]
	fn no_template_curly_in_string_fixture_matches_ts() {
		// Mirrors the `noTemplateCurlyInString` deliberate-literal fixture
		// from `tests/unit/render.test.ts`. Curly braces and dollar signs are
		// NOT escaped — only the canonical 8-char set is.
		let input = "Price: ${100} for {foo}";
		assert_eq!(escape_text(input), "Price: ${100} for {foo}");
	}

	#[test]
	fn escape_attr_matches_escape_text_in_55_1() {
		// AC7: same byte mapping today; split is structural for future
		// attr-context divergence. If this assertion fails it indicates an
		// unintentional drift between the two entry points.
		let input = "&<>\"'`\u{2028}\u{2029}";
		assert_eq!(escape_attr(input), escape_text(input));
	}
}
