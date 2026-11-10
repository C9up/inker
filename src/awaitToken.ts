/**
 * Whether a template expression uses `await` as an operator — the one thing
 * that makes it need an async function. The word inside a string, a template
 * literal's text, a comment or a regular expression literal does not count,
 * nor does a property or object key named `await`.
 *
 * A single linear pass of a JavaScript tokenizer reduced to what this needs:
 * literals, comments, template substitutions (nested to any depth), and the
 * regex-or-division choice made from the previous significant token, as a
 * JavaScript parser makes it in expression position.
 */

// After these words a `/` starts a regular expression, not a division.
const REGEX_AFTER_WORDS: ReadonlySet<string> = new Set([
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
]);

// An `await` followed by one of these is an identifier (`await: 1`,
// `{ await }`, `await = x`, `await ? a : b`, `await.x`), not an operator.
const NOT_AN_OPERAND = new Set([":", ",", ")", "]", "}", ";", "=", "?", "."]);

const ID_START_RE = /[\p{ID_Start}$_\\]/u;
const ID_PART_RE = /[\p{ID_Continue}$\\]|\u200c|\u200d/u;

function isLineTerminator(ch: string): boolean {
	return ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
}

function isWhitespace(ch: string): boolean {
	return /\s/u.test(ch);
}

/** Index just past the comment starting at `at` (`//` or `/*`). */
function skipComment(source: string, at: number): number {
	if (source.charAt(at + 1) === "/") {
		let i = at + 2;
		while (i < source.length && !isLineTerminator(source.charAt(i))) i++;
		return i;
	}
	const end = source.indexOf("*/", at + 2);
	return end === -1 ? source.length : end + 2;
}

function isCommentStart(source: string, at: number): boolean {
	const next = source.charAt(at + 1);
	return source.charAt(at) === "/" && (next === "/" || next === "*");
}

/** Index of the next significant character at or after `at`. */
function skipTrivia(source: string, at: number): number {
	let i = at;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (isWhitespace(ch)) i++;
		else if (isCommentStart(source, i)) i = skipComment(source, i);
		else break;
	}
	return i;
}

/** Index just past the quoted string opening at `at`. */
function skipString(source: string, at: number): number {
	const quote = source.charAt(at);
	let i = at + 1;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (ch === "\\") i += 2;
		else if (ch === quote || isLineTerminator(ch)) return i + 1;
		else i++;
	}
	return i;
}

/** Index just past the regular expression literal opening at `at`. */
function skipRegex(source: string, at: number): number {
	let i = at + 1;
	let inClass = false;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (isLineTerminator(ch)) return i;
		i++;
		if (ch === "[") inClass = true;
		else if (ch === "]") inClass = false;
		else if (ch === "/" && !inClass) break;
	}
	while (i < source.length && ID_PART_RE.test(source.charAt(i))) i++;
	return i;
}

/**
 * Scan a template literal's text from `at` (just past its backtick, or past
 * the `}` closing a substitution). `end` is where the scan stopped; `open`
 * tells whether that is inside a new `${` substitution or past the closing
 * backtick.
 */
function skipTemplateText(
	source: string,
	at: number,
): { end: number; open: boolean } {
	let i = at;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (ch === "\\") i += 2;
		else if (ch === "`") return { end: i + 1, open: false };
		else if (ch === "$" && source.charAt(i + 1) === "{") {
			return { end: i + 2, open: true };
		} else i++;
	}
	return { end: i, open: false };
}

export function hasAwaitOperator(source: string): boolean {
	if (!source.includes("await")) return false;
	// Brace depth at which each open template substitution started.
	const substitutions: number[] = [];
	let depth = 0;
	let regexAllowed = true;
	let afterDot = false;
	let i = 0;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (isWhitespace(ch)) {
			i++;
			continue;
		}
		if (isCommentStart(source, i)) {
			i = skipComment(source, i);
			continue;
		}
		const wasAfterDot = afterDot;
		afterDot = false;
		if (ch === "/") {
			if (regexAllowed) {
				i = skipRegex(source, i);
				regexAllowed = false;
			} else {
				i += source.charAt(i + 1) === "=" ? 2 : 1;
				regexAllowed = true;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			i = skipString(source, i);
			regexAllowed = false;
			continue;
		}
		if (ch === "`" || (ch === "}" && substitutions.at(-1) === depth - 1)) {
			if (ch === "}") {
				substitutions.pop();
				depth--;
			}
			const text = skipTemplateText(source, i + 1);
			i = text.end;
			if (text.open) {
				substitutions.push(depth);
				depth++;
			}
			regexAllowed = text.open;
			continue;
		}
		if (ID_START_RE.test(ch) || ch === "#") {
			let end = i + 1;
			while (end < source.length && ID_PART_RE.test(source.charAt(end))) end++;
			const word = source.slice(i, end);
			i = end;
			if (word === "await" && !wasAfterDot) {
				const next = skipTrivia(source, i);
				if (
					next < source.length &&
					!NOT_AN_OPERAND.has(source.charAt(next)) &&
					// `await => …` is an arrow function's parameter.
					source.slice(next, next + 2) !== "=>"
				) {
					return true;
				}
			}
			regexAllowed = REGEX_AFTER_WORDS.has(word) && !wasAfterDot;
			continue;
		}
		if (
			/[0-9]/.test(ch) ||
			(ch === "." && /[0-9]/.test(source.charAt(i + 1)))
		) {
			i++;
			while (i < source.length) {
				const c = source.charAt(i);
				if (ID_PART_RE.test(c) || c === ".") i++;
				else if (
					(c === "+" || c === "-") &&
					/[eE]/.test(source.charAt(i - 1))
				) {
					i++;
				} else break;
			}
			regexAllowed = false;
			continue;
		}
		if (ch === "." && source.charAt(i + 1) !== ".") {
			afterDot = true;
			i++;
			regexAllowed = false;
			continue;
		}
		if (
			ch === "?" &&
			source.charAt(i + 1) === "." &&
			!/[0-9]/.test(source.charAt(i + 2))
		) {
			afterDot = true;
			i += 2;
			regexAllowed = false;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		if (ch === ")" || ch === "]" || ch === "}") {
			regexAllowed = false;
		} else if (
			(ch === "+" || ch === "-") &&
			source.charAt(i + 1) === ch &&
			!regexAllowed
		) {
			// A postfix `++` / `--` ends an operand: a `/` after it divides.
			i += 2;
			continue;
		} else {
			regexAllowed = true;
		}
		i++;
	}
	return false;
}
