//! A reduced JavaScript scanner shared by the lexer and the tag parsers: it
//! steps over string, template (with `${…}` substitutions nested to any
//! depth), regular-expression and comment tokens so a bracket, comma, quote or
//! `)` inside one is never taken for structure.
//!
//! The regex-or-division choice is the one a JavaScript parser makes in
//! expression position, from the previous significant token: a `/` after a
//! value (identifier, number, literal, `)`, `]`, `}`, postfix `++`/`--`)
//! divides; after an operator, an opening bracket, or a keyword such as
//! `typeof` or `return` it starts a regex.

/// Keywords after which a `/` starts a regex literal rather than a division.
const REGEX_AFTER_WORDS: &[&str] = &[
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
];

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The `prev_sig` to carry past the token starting at `i`: a comment leaves
/// the previous significant char as it was, any other token is a value
/// (marked `'x'`).
pub(crate) fn token_prev_sig(chars: &[char], i: usize, prev: char) -> char {
    let is_comment = chars[i] == '/' && matches!(chars.get(i + 1).copied(), Some('/') | Some('*'));
    if is_comment {
        prev
    } else {
        'x'
    }
}

/// How deep template literals may nest through `${…}` substitutions before the
/// scan gives up — the same bound the block and expression parsers apply
/// (`MAX_BLOCK_DEPTH` in parse.rs, `MAX_EXPRESSION_DEPTH` in
/// parse_expression.rs).
pub(crate) const MAX_TEMPLATE_DEPTH: usize = crate::parse::MAX_BLOCK_DEPTH;

/// A template literal nested through `${…}` deeper than [`MAX_TEMPLATE_DEPTH`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TooDeep;

impl TooDeep {
    /// The message every caller reports, so the bound reads the same wherever
    /// the scan hits it.
    pub(crate) fn message() -> String {
        format!(
            "template literals nest beyond the maximum depth of {MAX_TEMPLATE_DEPTH} — flatten the expression or move logic to a helper"
        )
    }
}

/// If `chars[i]` begins a string / template literal / regex literal / comment,
/// return the index just past that token; otherwise `None`. `prev_sig` is the
/// last significant char before `i` (see [`token_prev_sig`]), used with the
/// text before `i` to tell a regex literal (`= /re/`) from a division
/// (`a / b`). A template literal nested past [`MAX_TEMPLATE_DEPTH`] is
/// [`TooDeep`].
pub(crate) fn skip_js_token(
    chars: &[char],
    i: usize,
    prev_sig: char,
) -> Result<Option<usize>, TooDeep> {
    if chars[i] == '`' {
        return skip_template(chars, i).map(Some);
    }
    Ok(skip_flat_token(chars, i, prev_sig))
}

/// The tokens that cannot nest: strings, comments and regex literals.
fn skip_flat_token(chars: &[char], i: usize, prev_sig: char) -> Option<usize> {
    match chars[i] {
        '\'' | '"' => Some(skip_string(chars, i)),
        '/' => match chars.get(i + 1).copied() {
            Some('/') => Some(skip_line_comment(chars, i)),
            Some('*') => Some(skip_block_comment(chars, i)),
            _ if regex_allowed(chars, i, prev_sig) => Some(skip_regex(chars, i)),
            _ => None, // division
        },
        _ => None,
    }
}

/// Whether a `/` at `i` starts a regex literal.
fn regex_allowed(chars: &[char], i: usize, prev_sig: char) -> bool {
    let mut k = i;
    while k > 0 && chars[k - 1].is_whitespace() {
        k -= 1;
    }
    if k > 0 {
        let c = chars[k - 1];
        if is_ident_char(c) {
            // A word: a regex only after one of the keywords above, and not
            // when it is a property (`a.typeof / 2`). A number, a regex's
            // flags or any other name is a value.
            let mut s = k - 1;
            while s > 0 && is_ident_char(chars[s - 1]) {
                s -= 1;
            }
            let word: String = chars[s..k].iter().collect();
            let property = s > 0 && chars[s - 1] == '.';
            return !property && REGEX_AFTER_WORDS.contains(&word.as_str());
        }
        if (c == '+' || c == '-') && k >= 2 && chars[k - 2] == c {
            // `++` / `--`: postfix after a value (then `/` divides), prefix
            // otherwise.
            let mut m = k - 2;
            while m > 0 && chars[m - 1].is_whitespace() {
                m -= 1;
            }
            let after_value = m > 0 && {
                let p = chars[m - 1];
                is_ident_char(p) || p == ')' || p == ']'
            };
            return !after_value;
        }
    }
    regex_allowed_after(prev_sig)
}

/// A `/` starts a regex literal (rather than division) when the previous
/// significant char is not a value terminator (identifier char, `)`, `]`, `}`,
/// `.`, or a just-closed literal — marked `'x'`).
fn regex_allowed_after(prev: char) -> bool {
    !(is_ident_char(prev) || prev == ')' || prev == ']' || prev == '}' || prev == '.')
}

/// Skip a `'`/`"` string starting at `i`; returns the index past the close.
pub(crate) fn skip_string(chars: &[char], i: usize) -> usize {
    let quote = chars[i];
    let mut j = i + 1;
    while j < chars.len() {
        match chars[j] {
            '\\' => j += 2,
            c if c == quote => return j + 1,
            _ => j += 1,
        }
    }
    j.min(chars.len())
}

/// One open construct of the template-literal scan: the literal's text, or a
/// `${…}` substitution with its own bracket depth and regex-vs-division state.
enum Frame {
    Template,
    Substitution { braces: u32, prev_sig: char },
}

/// Skip a `` ` `` template literal starting at `i`, balancing nested `${…}`
/// substitutions (which may themselves contain strings/templates/brackets).
///
/// Iterative over an explicit stack: a template nested through `${` once per
/// level used to cost one native frame per level, and a few hundred thousand
/// levels in a tag argument overflowed the thread's stack and killed the
/// process. Nesting past [`MAX_TEMPLATE_DEPTH`] is refused instead.
fn skip_template(chars: &[char], i: usize) -> Result<usize, TooDeep> {
    let mut stack = vec![Frame::Template];
    let mut templates = 1usize;
    let mut j = i + 1;
    while j < chars.len() {
        let Some(top) = stack.last_mut() else {
            break;
        };
        match top {
            Frame::Template => match chars[j] {
                '\\' => j += 2,
                '`' => {
                    stack.pop();
                    templates -= 1;
                    j += 1;
                    if stack.is_empty() {
                        return Ok(j);
                    }
                }
                '$' if chars.get(j + 1).copied() == Some('{') => {
                    stack.push(Frame::Substitution {
                        braces: 1,
                        prev_sig: '{',
                    });
                    j += 2;
                }
                _ => j += 1,
            },
            Frame::Substitution { braces, prev_sig } => {
                let c = chars[j];
                if c == '`' {
                    // A template is a value for the regex-vs-division choice.
                    *prev_sig = 'x';
                    templates += 1;
                    if templates > MAX_TEMPLATE_DEPTH {
                        return Err(TooDeep);
                    }
                    stack.push(Frame::Template);
                    j += 1;
                    continue;
                }
                if let Some(next) = skip_flat_token(chars, j, *prev_sig) {
                    *prev_sig = token_prev_sig(chars, j, *prev_sig);
                    j = next;
                    continue;
                }
                match c {
                    '{' => *braces += 1,
                    '}' => {
                        *braces -= 1;
                        if *braces == 0 {
                            stack.pop();
                            j += 1;
                            continue;
                        }
                    }
                    _ => {}
                }
                if !c.is_whitespace() {
                    *prev_sig = c;
                }
                j += 1;
            }
        }
    }
    Ok(j.min(chars.len()))
}

/// Skip a `//` line comment; returns the index of the terminating newline (or
/// end of input).
pub(crate) fn skip_line_comment(chars: &[char], i: usize) -> usize {
    let mut j = i + 2;
    while j < chars.len() && chars[j] != '\n' {
        j += 1;
    }
    j
}

/// Skip a `/* … */` block comment; returns the index past `*/`.
pub(crate) fn skip_block_comment(chars: &[char], i: usize) -> usize {
    let mut j = i + 2;
    while j + 1 < chars.len() {
        if chars[j] == '*' && chars[j + 1] == '/' {
            return j + 2;
        }
        j += 1;
    }
    chars.len()
}

/// Skip a `/…/flags` regex literal starting at `i`, honouring `\` escapes and
/// `[…]` character classes (a `/` inside a class is literal).
fn skip_regex(chars: &[char], i: usize) -> usize {
    let mut j = i + 1;
    let mut in_class = false;
    while j < chars.len() {
        match chars[j] {
            '\\' => {
                j += 2;
                continue;
            }
            '[' => in_class = true,
            ']' => in_class = false,
            '/' if !in_class => {
                j += 1;
                while j < chars.len() && chars[j].is_alphabetic() {
                    j += 1;
                }
                return j;
            }
            '\n' => return j, // unterminated
            _ => {}
        }
        j += 1;
    }
    j.min(chars.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token_end(source: &str, at: usize, prev: char) -> Option<usize> {
        let chars: Vec<char> = source.chars().collect();
        skip_js_token(&chars, at, prev).unwrap_or(None)
    }

    fn nested_templates(depth: usize) -> String {
        format!("{}1{}", "`${".repeat(depth), "}`".repeat(depth))
    }

    #[test]
    fn template_literal_with_nested_substitutions_and_escapes() {
        let s = "`a,${`b,${'}'}`}\\`c` + x";
        assert_eq!(token_end(s, 0, '\0'), Some(s.find(" +").unwrap_or(0)));
    }

    #[test]
    fn regex_after_keyword_division_after_value() {
        // `typeof /a,b/` is a regex; `x / 2` and `a++ / 2` divide.
        assert!(token_end("typeof /a,b/", 7, 'f').is_some());
        assert_eq!(token_end("x / 2", 2, 'x'), None);
        assert_eq!(token_end("a++ / 2, b", 4, '+'), None);
        assert_eq!(token_end("a.typeof / 2", 9, 'f'), None);
        assert_eq!(token_end("/x/g / 2", 5, 'x'), None);
        // Prefix `++` then a regex makes no sense but parses as one.
        assert!(token_end("(/a,b/)", 1, '(').is_some());
    }

    #[test]
    fn an_unterminated_token_stops_at_the_end() {
        assert_eq!(token_end("`abc", 0, '\0'), Some(4));
        assert_eq!(token_end("'ab\\", 0, '\0'), Some(4));
        assert_eq!(token_end("`${", 0, '\0'), Some(3));
    }

    #[test]
    fn a_template_nested_to_the_bound_is_one_token() {
        let s = nested_templates(MAX_TEMPLATE_DEPTH);
        let chars: Vec<char> = s.chars().collect();
        assert_eq!(skip_js_token(&chars, 0, '\0'), Ok(Some(chars.len())));
    }

    #[test]
    fn a_template_nested_past_the_bound_is_refused_without_recursing() {
        // 200 000 levels overflowed the thread's stack when every `${` cost a
        // native frame; the scan now stops at the bound.
        for depth in [MAX_TEMPLATE_DEPTH + 1, 200_000] {
            let s = nested_templates(depth);
            let chars: Vec<char> = s.chars().collect();
            assert_eq!(skip_js_token(&chars, 0, '\0'), Err(TooDeep));
        }
    }

    #[test]
    fn sibling_templates_do_not_add_up_to_the_bound() {
        let s = format!("`{}`", "${`a`}".repeat(MAX_TEMPLATE_DEPTH * 4));
        let chars: Vec<char> = s.chars().collect();
        assert_eq!(skip_js_token(&chars, 0, '\0'), Ok(Some(chars.len())));
    }
}
