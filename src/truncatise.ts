/**
 * Character truncation with Edge's exact output — a port of `truncatise`, the
 * routine behind `@poppinss/string`'s `truncate` / `excerpt` that Edge's
 * globals call.
 *
 * NAMED DEVIATION (hardening): the upstream preprocessing uses regexes that
 * are quadratic on hostile input (`/<\/?[^>]+>/` and the paragraph rewrite
 * `/((.+)(\r?\n\r?\n|$))/` rescan a long run for every start position). Each
 * is replaced by a single pass that produces the same string, so excerpting a
 * user-authored body stays linear. The result is a plain string: `{{ }}`
 * escapes whatever markup it keeps.
 */

const SELF_CLOSING_TAGS: ReadonlySet<string> = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"keygen",
	"link",
	"menuitem",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

// What truncatise treats as part of a word when it completes one.
const WORD_CHAR_RE = /[a-zA-ZÇ-Ü']/i;

export interface TruncatiseOptions {
	readonly length: number;
	/** Cut exactly at `length` (true) or at the end of the current word. */
	readonly strict: boolean;
	readonly stripHtml: boolean;
	readonly suffix: string;
}

const NOT_TAG = 0;
const TAG_START = 1;
const TAG_ATTRIBUTES = 2;

export function truncatise(input: string, options: TruncatiseOptions): string {
	let text = input.trim();
	if (text === "" || (text.length <= options.length && !options.stripHtml)) {
		return text;
	}
	if (options.stripHtml) {
		text = stripTags(stripComments(text.replace(/<br( \/)?>/gi, " ")));
	}
	text = text.replace(/<\/p>(\r?\n)+<p>/gm, "</p><p>");
	if (options.stripHtml && /\r?\n\r?\n/.test(text)) text = wrapParagraphs(text);

	let out = "";
	let state = NOT_TAG;
	let currentTag = "";
	const tagStack: string[] = [];
	let charCounter = 0;
	let pointer = 0;
	for (; pointer < text.length; pointer++) {
		const ch = text.charAt(pointer);
		switch (ch) {
			case "<":
				if (state === NOT_TAG) {
					state = TAG_START;
					currentTag = "";
				}
				if (!options.stripHtml) out += ch;
				break;
			case ">":
				if (state === TAG_START || state === TAG_ATTRIBUTES) {
					state = NOT_TAG;
					currentTag = currentTag.toLowerCase();
					if (currentTag === "/p" && options.stripHtml) out += " ";
					if (
						!SELF_CLOSING_TAGS.has(currentTag) &&
						!SELF_CLOSING_TAGS.has(`${currentTag}/`)
					) {
						if (currentTag.includes("/")) tagStack.pop();
						else tagStack.push(currentTag);
					}
				}
				if (!options.stripHtml) out += ch;
				break;
			case " ":
				if (state === TAG_START) state = TAG_ATTRIBUTES;
				if (state === NOT_TAG) charCounter++;
				if (state === NOT_TAG || !options.stripHtml) out += ch;
				break;
			default:
				if (state === NOT_TAG) charCounter++;
				if (state === TAG_START) currentTag += ch;
				if (state === NOT_TAG || !options.stripHtml) out += ch;
				break;
		}
		const next = text.charAt(pointer + 1);
		const endOfWord =
			options.strict || !WORD_CHAR_RE.test(ch) || !WORD_CHAR_RE.test(next);
		if (options.length <= charCounter && endOfWord) break;
	}
	if (!options.stripHtml) {
		for (let tag = tagStack.pop(); tag !== undefined; tag = tagStack.pop()) {
			if (tag !== "!--") out += `</${tag}>`;
		}
	}
	if (pointer < text.length - 1) {
		out =
			out.slice(-4).toLowerCase() === "</p>"
				? `${out.slice(0, -4)}${options.suffix}${out.slice(-4)}`
				: out + options.suffix;
	}
	return out.trim();
}

/** A JavaScript line terminator — what a regex `.` does not match. */
function isLineTerminator(ch: string): boolean {
	return ch === "\n" || ch === "\r" || ch === " " || ch === " ";
}

/**
 * `text.replace(/<!--(.*?)-->/gm, "")`: a comment closes on the first `-->`
 * of its own line; one that reaches a line break first stays.
 */
function stripComments(text: string): string {
	let out = "";
	let i = 0;
	// Both only move forward, so the scan stays linear.
	let close = -1;
	let lineEnd = -1;
	for (;;) {
		const open = text.indexOf("<!--", i);
		if (open === -1) break;
		if (close < open + 4) close = text.indexOf("-->", open + 4);
		if (close === -1) break;
		if (lineEnd < open) {
			lineEnd = open;
			while (lineEnd < text.length && !isLineTerminator(text.charAt(lineEnd)))
				lineEnd++;
		}
		if (close + 3 > lineEnd) {
			// This comment cannot close on its line; the next `<!--` may.
			out += text.slice(i, open + 1);
			i = open + 1;
			continue;
		}
		out += text.slice(i, open);
		i = close + 3;
	}
	return out + text.slice(i);
}

/**
 * `text.replace(/<\/?[^>]+>/gi, "")`: a `<`, at least one character that is
 * not `>`, then `>`.
 */
function stripTags(text: string): string {
	let out = "";
	let i = 0;
	let close = -1;
	for (;;) {
		const open = text.indexOf("<", i);
		if (open === -1) break;
		if (close <= open) close = text.indexOf(">", open + 1);
		// No `>` after this `<`: no tag can close anywhere further on.
		if (close === -1) break;
		if (close === open + 1) {
			// `<>` is not a tag; scanning resumes at the `>`.
			out += text.slice(i, open + 1);
			i = open + 1;
			continue;
		}
		out += text.slice(i, open);
		i = close + 1;
	}
	return out + text.slice(i);
}

/**
 * `text.replace(/((.+)(\r?\n\r?\n|$))/gi, "<p>$2</p>")`: a line followed by a
 * blank line, or the last line, becomes a paragraph; a line followed by a
 * single line break is left as it is.
 */
function wrapParagraphs(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (isLineTerminator(text.charAt(i))) {
			out += text.charAt(i);
			i++;
			continue;
		}
		let end = i;
		while (end < text.length && !isLineTerminator(text.charAt(end))) end++;
		const line = text.slice(i, end);
		const separator = blankLineAt(text, end);
		if (separator > 0) {
			out += `<p>${line}</p>`;
			i = end + separator;
		} else if (end === text.length) {
			out += `<p>${line}</p>`;
			i = end;
		} else {
			out += line;
			i = end;
		}
	}
	return out;
}

/** Length of a `\r?\n\r?\n` starting at `at`, or 0. */
function blankLineAt(text: string, at: number): number {
	let j = at;
	for (let breaks = 0; breaks < 2; breaks++) {
		if (text.charAt(j) === "\r") j++;
		if (text.charAt(j) !== "\n") return 0;
		j++;
	}
	return j - at;
}
