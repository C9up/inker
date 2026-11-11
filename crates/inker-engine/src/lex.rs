//! Tokenizer — Edge-syntax control flow (Epic 62 / story 62.1).
//!
//! Produces five token kinds:
//!   - `Text` — verbatim source between control structures.
//!   - `InterpEscaped` — `{{ expr }}` (escape-by-default; trim markers `{{- -}}`).
//!   - `InterpRaw` — `{{{ expr }}}` (raw HTML pass-through).
//!   - `BlockTag` — `@keyword(args)` / `@keyword` / `@endkeyword` / `@!component(args)`
//!     (Edge `@`-tags; the un-`@`ed, paren-unwrapped inner `keyword args` is kept
//!     for parse_block_tag.rs). `@...` is no longer recognised.
//!   - `SlotPlaceholder` — `{{> name }}` (layout body slot).
//!
//! `@`-tag disambiguation follows Edge: `@word` is a block tag ONLY when `word`
//! (or `!word` / `endword`) is a known block keyword; any other `@…` (CSS
//! `@media`/`@keyframes`, `me@example.com`, JS `@decorator`) is literal text.
//!
//! Escapes (Edge parity): `@@` → literal `@`; `@{{` → literal `{{` (suppresses the
//! interpolation). The old backslash escapes (`\{{`, `\}}`, `\@`,(`\)`) are gone —
//! `@`/`` are ordinary text now and need no escaping.
//!
//! Position tracking is character-by-character. Templates are ASCII-heavy, so
//! char-count and UTF-16-code-unit-count diverge only on non-BMP scalars (4-byte
//! emoji etc.) — accepted divergence per DNR `feedback_no_drift_noise`; the
//! byte-parity suite uses ASCII fixtures.

use crate::error::{ErrorCode, InkerError};
use crate::js_scan::{skip_js_token, token_prev_sig, TooDeep};
use once_cell::sync::Lazy;
use regex::Regex;

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Text {
        value: String,
        line: u32,
        column: u32,
    },
    InterpEscaped {
        expression: String,
        line: u32,
        column: u32,
        expr_line: u32,
        expr_column: u32,
    },
    InterpRaw {
        expression: String,
        line: u32,
        column: u32,
        expr_line: u32,
        expr_column: u32,
    },
    BlockTag {
        raw: String,
        line: u32,
        column: u32,
    },
    SlotPlaceholder {
        name: String,
        line: u32,
        column: u32,
    },
    /// The line break that leads into a line of output (Edge's lexer emits it
    /// BEFORE each content line, never after a tag line).
    Newline {
        line: u32,
        column: u32,
    },
}

#[derive(Debug, Default, Clone)]
pub struct LexOptions {
    pub template_path: Option<String>,
    /// Runtime-registered custom tag names (Edge `registerTag`). `@<name>` lexes
    /// as a block tag when `name` is a built-in OR in this set.
    pub custom_tags: std::collections::HashSet<String>,
    /// The subset of `custom_tags` registered with `block: true`. Only these
    /// have a matching `@end<name>` to recognise.
    pub custom_block_tags: std::collections::HashSet<String>,
    /// Registered tags declared `noNewLine` (Edge): a line opening one also
    /// drops the line break that leads into the next line.
    pub no_newline_tags: std::collections::HashSet<String>,
}

static SLOT_NAME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-zA-Z_][a-zA-Z0-9_-]*$").expect("static regex compiles"));

#[derive(Debug, Clone, Copy)]
struct Cursor {
    line: u32,
    column: u32,
}

fn advance(cursor: &mut Cursor, ch: char) {
    if ch == '\n' {
        cursor.line += 1;
        cursor.column = 1;
    } else if ch == '\r' {
        // CR invisible to position tracking — a following LF resets the line.
        // A lone CR (classic-Mac) collapses subsequent text onto the same line.
    } else {
        cursor.column += 1;
    }
}

/// Block-tag keywords recognised at the `@` sigil. `@word` is a tag ONLY when
/// `word` is in this set (Edge parity — everything else, incl. CSS `@media` and
/// e-mail `@host`, is literal text). `section`/`endsection`/`super` are listed so
/// `@section` lexes as a tag and the PARSER rejects it cleanly (reserved for the
/// 62.3 layout-model story) rather than leaking through as text.
fn is_block_keyword(word: &str) -> bool {
    matches!(
        word,
        "if" | "elseif"
            | "else"
            | "endif"
            | "unless"
            | "endunless"
            | "each"
            | "endeach"
            | "let"
            | "include"
            | "includeIf"
            | "component"
            | "endcomponent"
            | "slot"
            | "endslot"
            | "layout"
            | "section"
            | "endsection"
            | "super"
            | "eval"
            | "dump"
            | "dd"
            | "assign"
            | "inject"
            | "debugger"
            | "newError"
            | "stack"
            | "pushTo"
            | "endpushTo"
            | "pushOnceTo"
            | "endpushOnceTo"
            | "end"
    )
}

/// A tag recognised at `i`: its keyword, whether it was written `@!`, and the
/// index one past the keyword.
struct TagMatch {
    word: String,
    self_closing: bool,
    after_word: usize,
}

/// `@[!]keyword` at `i`, when `keyword` is a tag (`@word` that is not one —
/// CSS `@media`, an e-mail address — is literal text).
fn tag_at(chars: &[char], i: usize, options: &LexOptions) -> Option<TagMatch> {
    if chars.get(i) != Some(&'@') {
        return None;
    }
    let self_closing = chars.get(i + 1) == Some(&'!');
    let word_start = if self_closing { i + 2 } else { i + 1 };
    let (word, after_word) = read_ident(chars, word_start);
    // A registered tag may be dotted (`@form.input`); a built-in keyword
    // never is, so this only ever lengthens a custom/component tag.
    let (word, after_word) = extend_dotted_tag(chars, word, after_word, options);
    // `@end<name>` closes a custom tag registered with `block: true`.
    let closes_custom_block = word
        .strip_prefix("end")
        .is_some_and(|n| options.custom_block_tags.contains(n));
    // `@!name` is the explicit self-closing form: valid for `component` and
    // for any block custom tag (which otherwise demands an `@end`).
    let self_closable = word == "component" || options.custom_block_tags.contains(word.as_str());
    // `me@end.org` is an address, not the generic closer.
    let end_in_address = word == "end"
        && chars.get(after_word) == Some(&'.')
        && chars
            .get(after_word + 1)
            .is_some_and(|c| c.is_ascii_alphanumeric());
    let known = is_block_keyword(&word)
        || options.custom_tags.contains(word.as_str())
        || closes_custom_block;
    if word.is_empty() || end_in_address || !known || (self_closing && !self_closable) {
        return None;
    }
    Some(TagMatch {
        word,
        self_closing,
        after_word,
    })
}

/// A closing tag: the generic `@end` or a named `@end<name>`.
fn is_closer(word: &str, options: &LexOptions) -> bool {
    word == "end"
        || word.strip_prefix("end").is_some_and(|n| {
            !n.is_empty() && (is_block_keyword(word) || options.custom_block_tags.contains(n))
        })
}

/// Edge's built-in tags declared `noNewLine` (`let`, `assign`, … and the
/// deprecated `layout`); a registered tag opts in through `no_newline_tags`.
fn drops_next_newline(word: &str, options: &LexOptions) -> bool {
    matches!(
        word,
        "let"
            | "assign"
            | "eval"
            | "inject"
            | "slot"
            | "pushTo"
            | "pushOnceTo"
            | "debugger"
            | "newError"
            | "layout"
    ) || options.no_newline_tags.contains(word)
}

fn is_line_break(ch: char) -> bool {
    ch == '\n' || ch == '\r'
}

/// `~` closing a tag line, optionally followed by spaces before the line
/// break (Edge accepts the marker only as the last thing on the line). Returns
/// the index one past the marker and its trailing spaces.
fn trim_marker_end(chars: &[char], i: usize) -> Option<usize> {
    if chars.get(i) != Some(&'~') {
        return None;
    }
    let mut j = i + 1;
    while j < chars.len() && (chars[j] == ' ' || chars[j] == '\t') {
        j += 1;
    }
    match chars.get(j) {
        None | Some('\n') | Some('\r') => Some(j),
        _ => None,
    }
}

/// Is `word` a tag the caller registered — either a tag name, or the
/// `@end<name>` of a block one?
fn is_registered_tag(word: &str, options: &LexOptions) -> bool {
    options.custom_tags.contains(word)
        || word
            .strip_prefix("end")
            .is_some_and(|n| options.custom_block_tags.contains(n))
}

/// Extend a just-read identifier across `.segment` parts while the longer name
/// is still a registered tag. Components exposed as tags are dotted —
/// `components/form/input` is `@form.input` — and a bare identifier read would
/// stop at `form`, leaving `.input(...)` as text. Falls back to the plain
/// identifier when no longer name matches, so `@media.print` in CSS stays text.
fn extend_dotted_tag(
    chars: &[char],
    word: String,
    after_word: usize,
    options: &LexOptions,
) -> (String, usize) {
    let mut best = if is_registered_tag(&word, options) {
        Some((word.clone(), after_word))
    } else {
        None
    };
    let mut candidate = word.clone();
    let mut i = after_word;
    while i < chars.len() && chars[i] == '.' {
        let (segment, next) = read_ident(chars, i + 1);
        if segment.is_empty() {
            break;
        }
        candidate.push('.');
        candidate.push_str(&segment);
        i = next;
        if is_registered_tag(&candidate, options) {
            best = Some((candidate.clone(), i));
        }
    }
    best.unwrap_or((word, after_word))
}

/// Read an ASCII identifier (`[A-Za-z][A-Za-z0-9]*`) starting at `i`. Returns the
/// word and the index one past its last char. Used to peek the keyword after an
/// `@` (or `@!`) sigil. Empty when `chars[i]` is not an identifier start.
fn read_ident(chars: &[char], i: usize) -> (String, usize) {
    let len = chars.len();
    let mut j = i;
    if j >= len || !(chars[j].is_ascii_alphabetic() || chars[j] == '_') {
        return (String::new(), i);
    }
    let mut out = String::new();
    while j < len && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
        out.push(chars[j]);
        j += 1;
    }
    (out, j)
}

// The `flush_text!` macro reassigns the text-start cursor after every flush so
// the NEXT text run starts at the right position; on the final flush (after the
// loop) that reassignment is legitimately dead. Suppress the macro-generated
// false positive rather than contort the macro.
#[allow(unused_assignments)]
pub fn lex(source: &str, options: &LexOptions) -> Result<Vec<Token>, InkerError> {
    // Char-indexed view so `chars[i + N]` is O(1) and mirrors TS's
    // `source[i + N]` byte-indexed access for ASCII templates.
    let chars: Vec<char> = source.chars().collect();
    let len = chars.len();
    let mut tokens: Vec<Token> = Vec::new();
    let mut cursor = Cursor { line: 1, column: 1 };
    let mut i = 0usize;

    let mut text_start_line = cursor.line;
    let mut text_start_column = cursor.column;
    let mut text_buf = String::new();
    // Set by a right-trim interpolation `{{ … -}}`; trims the leading whitespace
    // of the following text run (Edge whitespace-control parity).
    let mut trim_pending_left = false;

    // Edge's line model (edge-lexer `Tokenizer`): the line break that leads
    // into a line is emitted at the START of that line, and only when the line
    // is content — or a tag line right after another tag line. A closing tag
    // line emits none. A `~` at the end of a tag line, or a tag declared
    // `noNewLine` opening a line, drops the next one. Tags written mid-line are
    // an inker extension and leave the line breaks alone.
    let mut line_no: u32 = 1;
    let mut at_line_start = true;
    let mut is_last_line_a_tag = false;
    let mut drop_newline = false;
    // Set when the tag about to be lexed opens its line.
    let mut tag_at_line_start = false;
    // A `{{ … -}}` swallowed the line break: emit none for the next line.
    let mut suppress_newline = false;

    macro_rules! push_newline {
        () => {{
            if suppress_newline {
                suppress_newline = false;
            } else if line_no != 1 {
                if drop_newline {
                    drop_newline = false;
                } else {
                    tokens.push(Token::Newline {
                        line: cursor.line,
                        column: cursor.column,
                    });
                }
            }
        }};
    }

    macro_rules! flush_text {
        ($cursor:expr, $start_line:expr, $start_col:expr, $buf:expr, $toks:expr) => {{
            if !$buf.is_empty() {
                $toks.push(Token::Text {
                    value: std::mem::take(&mut $buf),
                    line: $start_line,
                    column: $start_col,
                });
            }
            $start_line = $cursor.line;
            $start_col = $cursor.column;
        }};
    }

    while i < len {
        // Right-trim carry-over from a `{{ … -}}`: swallow the leading whitespace
        // of this text run before doing anything else.
        if trim_pending_left {
            let mut crossed_line = false;
            while i < len
                && (chars[i] == ' ' || chars[i] == '\t' || chars[i] == '\r' || chars[i] == '\n')
            {
                if chars[i] == '\n' || (chars[i] == '\r' && chars.get(i + 1) != Some(&'\n')) {
                    line_no += 1;
                    crossed_line = true;
                }
                advance(&mut cursor, chars[i]);
                i += 1;
            }
            trim_pending_left = false;
            if crossed_line {
                at_line_start = true;
                suppress_newline = true;
            }
            text_start_line = cursor.line;
            text_start_column = cursor.column;
            if i >= len {
                break;
            }
        }

        if at_line_start {
            at_line_start = false;
            let mut j = i;
            while j < len && !is_line_break(chars[j]) && chars[j].is_whitespace() {
                j += 1;
            }
            match tag_at(&chars, j, options) {
                Some(found) => {
                    if !is_closer(&found.word, options) {
                        if is_last_line_a_tag {
                            push_newline!();
                        }
                        is_last_line_a_tag = true;
                    }
                    // Edge drops the indentation of a tag line.
                    while i < j {
                        advance(&mut cursor, chars[i]);
                        i += 1;
                    }
                    text_start_line = cursor.line;
                    text_start_column = cursor.column;
                    tag_at_line_start = true;
                }
                None => {
                    push_newline!();
                    is_last_line_a_tag = false;
                    // An empty line is still a line of content (Edge's raw `""`):
                    // a component's main slot keeps the break that follows it.
                    if is_line_break(chars[i]) {
                        tokens.push(Token::Text {
                            value: String::new(),
                            line: cursor.line,
                            column: cursor.column,
                        });
                    }
                }
            }
            suppress_newline = false;
        }
        let ch = chars[i];

        if is_line_break(ch) {
            flush_text!(cursor, text_start_line, text_start_column, text_buf, tokens);
            if ch == '\r' && chars.get(i + 1) == Some(&'\n') {
                advance(&mut cursor, '\r');
                i += 1;
            }
            advance(&mut cursor, chars[i]);
            i += 1;
            line_no += 1;
            at_line_start = true;
            text_start_line = cursor.line;
            text_start_column = cursor.column;
            continue;
        }

        // Edge `@` sigil: escapes (`@@`, `@{{`) + block tags (`@keyword(args)`,
        // `@keyword`, `@endkeyword`, `@!component(args)`). A `@word` that is not a
        // known block keyword is literal text (falls through below).
        if ch == '@' {
            // `@@` → literal `@`.
            if i + 1 < len && chars[i + 1] == '@' {
                text_buf.push('@');
                advance(&mut cursor, '@');
                advance(&mut cursor, '@');
                i += 2;
                continue;
            }
            // `@{{` → literal `{{` (suppress interpolation).
            if i + 2 < len && chars[i + 1] == '{' && chars[i + 2] == '{' {
                text_buf.push_str("{{");
                advance(&mut cursor, '@');
                advance(&mut cursor, '{');
                advance(&mut cursor, '{');
                i += 3;
                continue;
            }
            // `@[!]keyword` — a block tag only when `keyword` is known.
            if let Some(TagMatch {
                word,
                self_closing,
                after_word,
            }) = tag_at(&chars, i, options)
            {
                flush_text!(cursor, text_start_line, text_start_column, text_buf, tokens);
                let open_line = cursor.line;
                let open_column = cursor.column;
                // Advance over `@`, optional `!`, and the keyword chars.
                while i < after_word {
                    advance(&mut cursor, chars[i]);
                    i += 1;
                }
                // Edge allows up to two spaces between a tag and its `(`
                // (`@if (x)`). Closers and argument-less tags take none.
                if !is_closer(&word, options)
                    && !matches!(word.as_str(), "else" | "super" | "debugger")
                {
                    let mut j = i;
                    while j < len && j < i + 2 && (chars[j] == ' ' || chars[j] == '\t') {
                        j += 1;
                    }
                    if j > i && chars.get(j) == Some(&'(') {
                        while i < j {
                            advance(&mut cursor, chars[i]);
                            i += 1;
                        }
                    }
                }
                // Optional balanced `( … )` argument span. A `)` inside a
                // string, a template literal (and its `${…}`), a regex or a
                // comment does not close it.
                let mut args = String::new();
                if i < len && chars[i] == '(' {
                    advance(&mut cursor, '(');
                    i += 1;
                    let mut depth = 1usize;
                    let mut prev_sig = '(';
                    let mut closed = false;
                    while i < len {
                        let token = skip_js_token(&chars, i, prev_sig).map_err(|_| {
                            make_err(
                                ErrorCode::InvalidExpression,
                                format!(
                                    "'@{}(' at line {}, column {}: {}",
                                    word,
                                    open_line,
                                    open_column,
                                    TooDeep::message()
                                ),
                                open_line,
                                open_column,
                                options,
                            )
                        })?;
                        if let Some(next) = token {
                            prev_sig = token_prev_sig(&chars, i, prev_sig);
                            let next = next.min(len);
                            while i < next {
                                args.push(chars[i]);
                                advance(&mut cursor, chars[i]);
                                i += 1;
                            }
                            continue;
                        }
                        let c = chars[i];
                        if !c.is_whitespace() {
                            prev_sig = c;
                        }
                        if c == '(' {
                            depth += 1;
                        } else if c == ')' {
                            depth -= 1;
                            if depth == 0 {
                                advance(&mut cursor, ')');
                                i += 1;
                                closed = true;
                                break;
                            }
                        }
                        args.push(c);
                        advance(&mut cursor, c);
                        i += 1;
                    }
                    if !closed {
                        return Err(make_err(
                            ErrorCode::UnclosedBlockTag,
                            format!(
                                "Unclosed '@{}(' at line {}, column {}",
                                word, open_line, open_column
                            ),
                            open_line,
                            open_column,
                            options,
                        ));
                    }
                }
                // Reconstruct the `raw` parse_block_tag expects: `[!]keyword args`,
                // args paren-unwrapped + trimmed. Self-closing component keeps `!`.
                let kw = if self_closing {
                    format!("!{word}")
                } else {
                    word.clone()
                };
                let args_trimmed = args.trim();
                let raw = if args_trimmed.is_empty() {
                    kw
                } else {
                    format!("{kw} {args_trimmed}")
                };
                tokens.push(Token::BlockTag {
                    raw,
                    line: open_line,
                    column: open_column,
                });
                let opened_line = std::mem::take(&mut tag_at_line_start);
                if let Some(end) = trim_marker_end(&chars, i) {
                    drop_newline = true;
                    while i < end {
                        advance(&mut cursor, chars[i]);
                        i += 1;
                    }
                } else if opened_line && drops_next_newline(&word, options) {
                    drop_newline = true;
                }
                text_start_line = cursor.line;
                text_start_column = cursor.column;
                continue;
            }
            // Not a known tag — `@` is literal; fall through to text accumulation.
        }

        // Comment: {{-- ... --}} (Edge parity). Stripped entirely — emits no
        // token and no output, does not touch the data tree. Balanced against
        // the first `--}}`; an unterminated comment is a hard lex error so a
        // stray `{{--` cannot silently swallow the rest of the template.
        if ch == '{'
            && i + 3 < len
            && chars[i + 1] == '{'
            && chars[i + 2] == '-'
            && chars[i + 3] == '-'
        {
            flush_text!(cursor, text_start_line, text_start_column, text_buf, tokens);
            let open_line = cursor.line;
            let open_column = cursor.column;
            advance(&mut cursor, '{');
            advance(&mut cursor, '{');
            advance(&mut cursor, '-');
            advance(&mut cursor, '-');
            i += 4;
            let mut closed = false;
            while i < len {
                let c = chars[i];
                if c == '-'
                    && i + 3 < len
                    && chars[i + 1] == '-'
                    && chars[i + 2] == '}'
                    && chars[i + 3] == '}'
                {
                    advance(&mut cursor, '-');
                    advance(&mut cursor, '-');
                    advance(&mut cursor, '}');
                    advance(&mut cursor, '}');
                    i += 4;
                    closed = true;
                    break;
                }
                advance(&mut cursor, c);
                i += 1;
            }
            if !closed {
                return Err(make_err(
                    ErrorCode::UnclosedInterpolation,
                    format!(
                        "Unclosed comment (missing '--}}}}') at line {}, column {}",
                        open_line, open_column
                    ),
                    open_line,
                    open_column,
                    options,
                ));
            }
            text_start_line = cursor.line;
            text_start_column = cursor.column;
            continue;
        }

        // `@…` is no longer a control structure — it is ordinary text now
        // (Edge uses `@`-tags, handled at the `@` sigil above). No branch here.

        // Interpolation open: {{ ... }} / {{{ ... }}} / slot {{> ... }}
        if ch == '{' && i + 1 < len && chars[i + 1] == '{' {
            flush_text!(cursor, text_start_line, text_start_column, text_buf, tokens);
            let open_line = cursor.line;
            let open_column = cursor.column;
            let is_raw = i + 2 < len && chars[i + 2] == '{';

            if is_raw {
                advance(&mut cursor, '{');
                advance(&mut cursor, '{');
                advance(&mut cursor, '{');
                i += 3;
            } else {
                advance(&mut cursor, '{');
                advance(&mut cursor, '{');
                i += 2;
            }

            // Left-trim `{{- … }}` / `{{{- … }}}`: a `-` right after the braces
            // strips the trailing whitespace of the preceding text run.
            if i < len && chars[i] == '-' {
                advance(&mut cursor, '-');
                i += 1;
                // Back over the whitespace before it, line breaks included.
                loop {
                    match tokens.last_mut() {
                        Some(Token::Newline { .. }) => {
                            tokens.pop();
                        }
                        Some(Token::Text { value, .. }) => {
                            let trimmed = value.trim_end().to_string();
                            if trimmed.is_empty() {
                                tokens.pop();
                            } else {
                                *value = trimmed;
                                break;
                            }
                        }
                        _ => break,
                    }
                }
            }

            // Slot disambiguator: first non-whitespace char inside is `>`.
            // Double-brace only.
            if !is_raw {
                let mut probe = i;
                while probe < len {
                    let pc = chars[probe];
                    if pc == ' ' || pc == '\t' || pc == '\n' || pc == '\r' {
                        probe += 1;
                        continue;
                    }
                    break;
                }
                if probe < len && chars[probe] == '>' {
                    while i < probe {
                        advance(&mut cursor, chars[i]);
                        i += 1;
                    }
                    advance(&mut cursor, '>');
                    i += 1;

                    let mut name_inner = String::new();
                    let mut slot_closed = false;
                    while i < len {
                        let sc = chars[i];
                        if sc == '}' && i + 1 < len && chars[i + 1] == '}' {
                            if i + 2 < len && chars[i + 2] == '}' {
                                return Err(make_err(
                                    ErrorCode::UnclosedInterpolation,
                                    format!(
                                        "Asymmetric slot braces at line {}, column {}",
                                        open_line, open_column
                                    ),
                                    open_line,
                                    open_column,
                                    options,
                                ));
                            }
                            advance(&mut cursor, '}');
                            advance(&mut cursor, '}');
                            i += 2;
                            slot_closed = true;
                            break;
                        }
                        name_inner.push(sc);
                        advance(&mut cursor, sc);
                        i += 1;
                    }

                    if !slot_closed {
                        return Err(make_err(
                            ErrorCode::UnclosedInterpolation,
                            format!(
                                "Unclosed slot placeholder at line {}, column {}",
                                open_line, open_column
                            ),
                            open_line,
                            open_column,
                            options,
                        ));
                    }

                    let slot_name = name_inner.trim().to_string();
                    if slot_name.is_empty() {
                        return Err(make_err(
                            ErrorCode::ParseError,
                            format!(
                                "Empty slot name at line {}, column {}",
                                open_line, open_column
                            ),
                            open_line,
                            open_column,
                            options,
                        ));
                    }
                    if !SLOT_NAME_RE.is_match(&slot_name) {
                        return Err(make_err(
                            ErrorCode::ParseError,
                            format!(
                                "Invalid slot name '{}' at line {}, column {}",
                                slot_name, open_line, open_column
                            ),
                            open_line,
                            open_column,
                            options,
                        ));
                    }

                    tokens.push(Token::SlotPlaceholder {
                        name: slot_name,
                        line: open_line,
                        column: open_column,
                    });

                    text_start_line = cursor.line;
                    text_start_column = cursor.column;
                    continue;
                }
            }

            // Triple-brace + `>` is rejected.
            if is_raw {
                let mut probe = i;
                while probe < len {
                    let pc = chars[probe];
                    if pc == ' ' || pc == '\t' || pc == '\n' || pc == '\r' {
                        probe += 1;
                        continue;
                    }
                    break;
                }
                if probe < len && chars[probe] == '>' {
                    return Err(make_err(
                        ErrorCode::ParseError,
                        format!(
							"Slot placeholder must use double braces; got triple-brace form at line {}, column {}",
							open_line, open_column
						),
                        open_line,
                        open_column,
                        options,
                    ));
                }
            }

            // Inner-expression scan. String-aware so `}}` / `}}}` inside
            // quoted literals does not terminate the interpolation. The
            // (exprLine, exprColumn) snap to the first non-whitespace char
            // after the opening braces.
            let mut inner = String::new();
            let mut closed = false;
            let mut string_delim: Option<char> = None;
            let mut expr_line = cursor.line;
            let mut expr_column = cursor.column;
            let mut expr_start_found = false;

            while i < len {
                let c = chars[i];
                if string_delim.is_none() {
                    if is_raw {
                        if c == '}'
                            && i + 1 < len
                            && chars[i + 1] == '}'
                            && i + 2 < len
                            && chars[i + 2] == '}'
                        {
                            advance(&mut cursor, '}');
                            advance(&mut cursor, '}');
                            advance(&mut cursor, '}');
                            i += 3;
                            closed = true;
                            break;
                        }
                        if c == '}' && i + 1 < len && chars[i + 1] == '}' {
                            return Err(make_err(
                                ErrorCode::UnclosedInterpolation,
                                format!(
                                    "Unclosed triple-brace interpolation at line {}, column {}",
                                    open_line, open_column
                                ),
                                open_line,
                                open_column,
                                options,
                            ));
                        }
                    } else if c == '}' && i + 1 < len && chars[i + 1] == '}' {
                        if i + 2 < len && chars[i + 2] == '}' {
                            return Err(make_err(
                                ErrorCode::UnclosedInterpolation,
                                format!(
                                    "Asymmetric interpolation braces at line {}, column {}",
                                    open_line, open_column
                                ),
                                open_line,
                                open_column,
                                options,
                            ));
                        }
                        advance(&mut cursor, '}');
                        advance(&mut cursor, '}');
                        i += 2;
                        closed = true;
                        break;
                    }
                    if c == '"' || c == '\'' {
                        string_delim = Some(c);
                    }
                    if !expr_start_found && c != ' ' && c != '\t' && c != '\n' && c != '\r' {
                        expr_line = cursor.line;
                        expr_column = cursor.column;
                        expr_start_found = true;
                    }
                } else {
                    if c == '\\' && i + 1 < len {
                        let esc_next = chars[i + 1];
                        inner.push(c);
                        inner.push(esc_next);
                        advance(&mut cursor, c);
                        advance(&mut cursor, esc_next);
                        i += 2;
                        continue;
                    }
                    if Some(c) == string_delim {
                        string_delim = None;
                    }
                }
                inner.push(c);
                advance(&mut cursor, c);
                i += 1;
            }

            if !closed {
                return Err(make_err(
                    ErrorCode::UnclosedInterpolation,
                    format!(
                        "Unclosed interpolation at line {}, column {}",
                        open_line, open_column
                    ),
                    open_line,
                    open_column,
                    options,
                ));
            }

            // Right-trim `{{ … -}}` / `{{{ … -}}}`: a `-` right before the close
            // braces strips the leading whitespace of the following text run.
            if inner.ends_with('-') {
                inner.pop();
                trim_pending_left = true;
            }
            let expression = inner.trim().to_string();
            if expression.is_empty() {
                return Err(make_err(
                    ErrorCode::ParseError,
                    format!(
                        "Empty interpolation at line {}, column {}",
                        open_line, open_column
                    ),
                    open_line,
                    open_column,
                    options,
                ));
            }

            tokens.push(if is_raw {
                Token::InterpRaw {
                    expression,
                    line: open_line,
                    column: open_column,
                    expr_line,
                    expr_column,
                }
            } else {
                Token::InterpEscaped {
                    expression,
                    line: open_line,
                    column: open_column,
                    expr_line,
                    expr_column,
                }
            });

            text_start_line = cursor.line;
            text_start_column = cursor.column;
            continue;
        }

        text_buf.push(ch);
        advance(&mut cursor, ch);
        i += 1;
    }

    flush_text!(cursor, text_start_line, text_start_column, text_buf, tokens);
    // A source ending with a line break ends with an empty line, which Edge
    // still leads into.
    if at_line_start {
        push_newline!();
    }
    Ok(tokens)
}

fn make_err(
    code: ErrorCode,
    message: String,
    line: u32,
    column: u32,
    options: &LexOptions,
) -> InkerError {
    let mut err = InkerError::new(code, message).with_pos(line, column);
    if let Some(name) = &options.template_path {
        err = err.with_template(name.clone());
    }
    err
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_source_returns_empty() {
        let toks = lex("", &LexOptions::default()).unwrap();
        assert!(toks.is_empty());
    }

    #[test]
    fn pure_text_passes_through() {
        let toks = lex("hello world", &LexOptions::default()).unwrap();
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::Text {
                value,
                line,
                column,
            } => {
                assert_eq!(value, "hello world");
                assert_eq!(*line, 1);
                assert_eq!(*column, 1);
            }
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn double_brace_emits_interp_escaped() {
        let toks = lex("{{ name }}", &LexOptions::default()).unwrap();
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::InterpEscaped { expression, .. } => assert_eq!(expression, "name"),
            _ => panic!("expected InterpEscaped"),
        }
    }

    #[test]
    fn triple_brace_emits_interp_raw() {
        let toks = lex("{{{ raw }}}", &LexOptions::default()).unwrap();
        assert_eq!(toks.len(), 1);
        assert!(matches!(toks[0], Token::InterpRaw { .. }));
    }

    #[test]
    fn slot_disambiguator() {
        let toks = lex("{{> body }}", &LexOptions::default()).unwrap();
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::SlotPlaceholder { name, .. } => assert_eq!(name, "body"),
            _ => panic!("expected SlotPlaceholder"),
        }
    }

    #[test]
    fn block_tag_emits_raw_inner() {
        let toks = lex("@layout('main')", &LexOptions::default()).unwrap();
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::BlockTag { raw, .. } => assert_eq!(raw, "layout 'main'"),
            _ => panic!("expected BlockTag"),
        }
    }

    #[test]
    fn block_tag_args_skip_parens_and_quotes_inside_literals() {
        for (source, raw) in [
            ("@include(`it's`)", "include `it's`"),
            ("@include(`a)${b(')')}`)", "include `a)${b(')')}`"),
            ("@if(/\\)/.test(x))", "if /\\)/.test(x)"),
            ("@if(x /* ) */)", "if x /* ) */"),
            ("@if((a) / b)", "if (a) / b"),
        ] {
            let toks = lex(source, &LexOptions::default()).unwrap();
            match &toks[0] {
                Token::BlockTag { raw: got, .. } => assert_eq!(got, raw, "{source}"),
                _ => panic!("expected BlockTag for {source}"),
            }
        }
    }

    #[test]
    fn at_escapes_produce_literal_output() {
        // `@@` → literal `@`; `@{{` → literal `{{` (suppress interpolation).
        let toks = lex("a@@b @{{ x }}c", &LexOptions::default()).unwrap();
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::Text { value, .. } => assert_eq!(value, "a@b {{ x }}c"),
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn trim_markers_strip_adjacent_whitespace() {
        // `{{- x -}}` trims trailing ws of the preceding text + leading ws of next.
        let toks = lex("a   {{- x -}}   b", &LexOptions::default()).unwrap();
        assert_eq!(toks.len(), 3);
        match &toks[0] {
            Token::Text { value, .. } => assert_eq!(value, "a"),
            _ => panic!("expected Text 'a'"),
        }
        match &toks[1] {
            Token::InterpEscaped { expression, .. } => assert_eq!(expression, "x"),
            _ => panic!("expected InterpEscaped 'x'"),
        }
        match &toks[2] {
            Token::Text { value, .. } => assert_eq!(value, "b"),
            _ => panic!("expected Text 'b'"),
        }
    }

    #[test]
    fn unclosed_interpolation_errors() {
        let err = lex("{{ foo", &LexOptions::default()).unwrap_err();
        assert_eq!(err.code, ErrorCode::UnclosedInterpolation);
    }

    #[test]
    fn unclosed_block_tag_errors() {
        let err = lex("@if(x", &LexOptions::default()).unwrap_err();
        assert_eq!(err.code, ErrorCode::UnclosedBlockTag);
    }

    #[test]
    fn empty_interp_errors_as_parse_error() {
        let err = lex("{{ }}", &LexOptions::default()).unwrap_err();
        assert_eq!(err.code, ErrorCode::ParseError);
    }

    #[test]
    fn string_close_brace_inside_quotes_does_not_terminate() {
        let toks = lex("{{ \"a}}b\" }}", &LexOptions::default()).unwrap();
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::InterpEscaped { expression, .. } => {
                assert_eq!(expression, "\"a}}b\"");
            }
            _ => panic!("expected InterpEscaped"),
        }
    }

    #[test]
    fn comment_is_stripped_entirely() {
        let toks = lex("a{{-- hidden {{ x }} --}}b", &LexOptions::default()).unwrap();
        assert_eq!(toks.len(), 2);
        match (&toks[0], &toks[1]) {
            (Token::Text { value: a, .. }, Token::Text { value: b, .. }) => {
                assert_eq!(a, "a");
                assert_eq!(b, "b");
            }
            _ => panic!("expected two Text tokens around the stripped comment"),
        }
    }

    #[test]
    fn comment_only_emits_no_tokens() {
        let toks = lex("{{-- just a note --}}", &LexOptions::default()).unwrap();
        assert!(toks.is_empty());
    }

    #[test]
    fn unclosed_comment_errors() {
        let err = lex("{{-- never closed", &LexOptions::default()).unwrap_err();
        assert_eq!(err.code, ErrorCode::UnclosedInterpolation);
    }

    #[test]
    fn text_then_interp_then_text() {
        let toks = lex("hi {{ x }} bye", &LexOptions::default()).unwrap();
        assert_eq!(toks.len(), 3);
        assert!(matches!(toks[0], Token::Text { .. }));
        assert!(matches!(toks[1], Token::InterpEscaped { .. }));
        assert!(matches!(toks[2], Token::Text { .. }));
    }
}
