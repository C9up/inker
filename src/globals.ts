import { SafeString } from "./SafeString.js";

/**
 * Edge-core built-in globals (62-7). Always in scope for every expression,
 * mirroring `edge`'s built-in helpers (string/case/number/html/debug). Consumer
 * helpers registered on a `Templates` instance overlay these (can override).
 *
 * `nl2br` and the `html.*` helpers return `SafeString` (raw HTML), matching Edge.
 */

function str(v: unknown): string {
	return v === null || v === undefined ? "" : String(v);
}

// ---- case conversion ----

function words(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_\-\s]+/g, " ")
		.trim()
		.split(" ")
		.filter((w) => w.length > 0);
}

function cap(w: string): string {
	return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function camelCase(value: unknown): string {
	return words(str(value))
		.map((w, i) => (i === 0 ? w.toLowerCase() : cap(w)))
		.join("");
}

function pascalCase(value: unknown): string {
	return words(str(value)).map(cap).join("");
}

function snakeCase(value: unknown): string {
	return words(str(value))
		.map((w) => w.toLowerCase())
		.join("_");
}

function dashCase(value: unknown): string {
	return words(str(value))
		.map((w) => w.toLowerCase())
		.join("-");
}

function capitalCase(value: unknown): string {
	return words(str(value)).map(cap).join(" ");
}

/** Words that stay lower-case inside a title (the `title-case` package's list,
 * which is what Edge's `titleCase` runs on). */
const SMALL_WORDS =
	/^(a|an|and|as|at|but|by|en|for|if|in|nor|of|on|or|per|the|to|v\.?|vs\.?|via)$/i;

/**
 * Title case: every word capitalised EXCEPT the small words, which stay
 * lower-case unless they open or close the title — "a tale of two cities"
 * becomes "A Tale of Two Cities", not "A Tale Of Two Cities". `capitalCase`
 * is the capitalise-everything variant.
 */
function titleCase(value: unknown): string {
	const list = words(str(value));
	return list
		.map((w, i) =>
			SMALL_WORDS.test(w) && i !== 0 && i !== list.length - 1
				? w.toLowerCase()
				: cap(w),
		)
		.join(" ");
}

function sentenceCase(value: unknown): string {
	return words(str(value))
		.map((w, i) =>
			i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase(),
		)
		.join(" ");
}

function noCase(value: unknown): string {
	return words(str(value))
		.map((w) => w.toLowerCase())
		.join(" ");
}

// INKER DEVIATION (named): lower-cased, like `snakeCase` and `dashCase` here.
// Edge's `dotCase` takes a `lowerCase` option; a single consistent casing
// across the delimiter-joining helpers is worth more than that knob.
function dotCase(value: unknown): string {
	return words(str(value))
		.map((w) => w.toLowerCase())
		.join(".");
}

interface SentenceOptions {
	readonly separator?: string;
	readonly pairSeparator?: string;
	readonly lastSeparator?: string;
}

/** Join a list the way a sentence would: `['a', 'b', 'c']` → `a, b, and c`. */
function sentence(
	values: readonly unknown[],
	options: SentenceOptions = {},
): string {
	if (!Array.isArray(values)) return str(values);
	const list = values.map(str);
	if (list.length === 0) return "";
	if (list.length === 1) return list[0] ?? "";
	// Two items read better without a comma at all.
	if (list.length === 2)
		return `${list[0]}${options.pairSeparator ?? " and "}${list[1]}`;
	const head = list.slice(0, -1).join(options.separator ?? ", ");
	return `${head}${options.lastSeparator ?? ", and "}${list[list.length - 1]}`;
}

// ---- string manipulation ----

interface TruncateOptions {
	readonly suffix?: string;
	readonly completeWords?: boolean;
}

function truncate(
	value: unknown,
	length = 20,
	options: TruncateOptions = {},
): string {
	const s = str(value);
	if (s.length <= length) return s;
	const suffix = options.suffix ?? "…";
	let end = length;
	if (options.completeWords) {
		// extend to the next word boundary so a word is never cut mid-way
		while (end < s.length && s.charAt(end) !== " ") end += 1;
	}
	return s.slice(0, end).trimEnd() + suffix;
}

function excerpt(
	value: unknown,
	length = 20,
	options: TruncateOptions = {},
): string {
	const plain = str(value).replace(/<[^>]*>/g, "");
	return truncate(plain, length, options);
}

function nl2br(value: unknown): SafeString {
	return new SafeString(str(value).replace(/\r\n|\r|\n/g, "<br>"));
}

// ---- pluralization ----

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
	person: "people",
	child: "children",
	man: "men",
	woman: "women",
	tooth: "teeth",
	foot: "feet",
	mouse: "mice",
	goose: "geese",
};

function pluralOf(word: string): string {
	const lower = word.toLowerCase();
	const irregular = IRREGULAR_PLURALS[lower];
	if (irregular !== undefined) return irregular;
	if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
	if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
	return `${word}s`;
}

function pluralize(word: unknown, count?: number): string {
	const w = str(word);
	if (count === 1) return w;
	return pluralOf(w);
}

// ---- number formatting ----

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

function prettyBytes(value: unknown): string {
	const n = Number(value);
	if (!Number.isFinite(n)) return str(value);
	if (n === 0) return "0 B";
	const negative = n < 0;
	const abs = Math.abs(n);
	const exp = Math.min(Math.floor(Math.log10(abs) / 3), BYTE_UNITS.length - 1);
	const scaled = abs / 1000 ** exp;
	const rounded =
		exp === 0 ? String(scaled) : scaled.toFixed(2).replace(/\.?0+$/, "");
	return `${negative ? "-" : ""}${rounded} ${BYTE_UNITS[exp]}`;
}

function prettyMs(value: unknown): string {
	const ms = Number(value);
	if (!Number.isFinite(ms)) return str(value);
	if (Math.abs(ms) < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (Math.abs(s) < 60) return `${trimNum(s)}s`;
	const m = s / 60;
	if (Math.abs(m) < 60) return `${trimNum(m)}m`;
	const h = m / 60;
	if (Math.abs(h) < 24) return `${trimNum(h)}h`;
	return `${trimNum(h / 24)}d`;
}

function trimNum(n: number): string {
	return n.toFixed(2).replace(/\.?0+$/, "");
}

/** Multipliers for `toBytes`, matched case-insensitively. Both the decimal
 * (`kB` = 1000) and binary (`KiB` = 1024) prefixes are accepted. */
const BYTE_MULTIPLIERS: Readonly<Record<string, number>> = {
	b: 1,
	kb: 1000,
	mb: 1000 ** 2,
	gb: 1000 ** 3,
	tb: 1000 ** 4,
	pb: 1000 ** 5,
	kib: 1024,
	mib: 1024 ** 2,
	gib: 1024 ** 3,
	tib: 1024 ** 4,
	pib: 1024 ** 5,
};

/** Parse a human byte size (`"1kb"`, `"2.5 MB"`) back to a number. */
function toBytes(value: unknown): number | null {
	if (typeof value === "number") return value;
	const match = /^\s*(-?[\d.]+)\s*([a-z]*)\s*$/i.exec(str(value));
	if (match === null) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return null;
	const unit = (match[2] ?? "").toLowerCase();
	const multiplier = unit === "" ? 1 : BYTE_MULTIPLIERS[unit];
	return multiplier === undefined ? null : amount * multiplier;
}

const MS_MULTIPLIERS: Readonly<Record<string, number>> = {
	ms: 1,
	msec: 1,
	msecs: 1,
	millisecond: 1,
	milliseconds: 1,
	s: 1000,
	sec: 1000,
	secs: 1000,
	second: 1000,
	seconds: 1000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
	w: 604_800_000,
	week: 604_800_000,
	weeks: 604_800_000,
	y: 31_557_600_000,
	yr: 31_557_600_000,
	yrs: 31_557_600_000,
	year: 31_557_600_000,
	years: 31_557_600_000,
};

/** Parse a human duration (`"1h"`, `"2.5 days"`) back to milliseconds. */
function toMs(value: unknown): number | null {
	if (typeof value === "number") return value;
	const match = /^\s*(-?[\d.]+)\s*([a-z]*)\s*$/i.exec(str(value));
	if (match === null) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return null;
	const unit = (match[2] ?? "").toLowerCase();
	const multiplier = unit === "" ? 1 : MS_MULTIPLIERS[unit];
	return multiplier === undefined ? null : amount * multiplier;
}

function ordinal(value: unknown): string {
	const n = Number(value);
	if (!Number.isInteger(n)) return str(value);
	const abs = Math.abs(n) % 100;
	if (abs >= 11 && abs <= 13) return `${n}th`;
	switch (Math.abs(n) % 10) {
		case 1:
			return `${n}st`;
		case 2:
			return `${n}nd`;
		case 3:
			return `${n}rd`;
		default:
			return `${n}th`;
	}
}

// ---- html helpers ----

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// A valid HTML attribute name — no whitespace, quotes, `=`, `/`, `>` or control
// chars that could break out of the tag. The result is a raw SafeString, so an
// unvalidated key (e.g. `x onload=alert(1)` from a request-derived object) would
// be attribute-injection XSS; such keys are dropped rather than emitted.
const ATTR_NAME_RE = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

export function htmlAttrs(attrs: unknown): SafeString {
	if (attrs === null || typeof attrs !== "object") return new SafeString("");
	const parts: string[] = [];
	for (const [key, val] of Object.entries(attrs)) {
		if (val === false || val === null || val === undefined) continue;
		if (!ATTR_NAME_RE.test(key)) continue; // drop unsafe attribute names
		if (val === true) {
			parts.push(key);
		} else {
			parts.push(`${key}="${escapeAttr(String(val))}"`);
		}
	}
	return new SafeString(parts.join(" "));
}

function pushClasses(out: string[], arg: unknown): void {
	if (arg === null || arg === undefined || arg === false || arg === "") return;
	if (typeof arg === "string") {
		out.push(arg);
	} else if (Array.isArray(arg)) {
		for (const a of arg) pushClasses(out, a);
	} else if (typeof arg === "object") {
		for (const [cls, on] of Object.entries(arg)) {
			if (on) out.push(cls);
		}
	}
}

function classNames(...args: readonly unknown[]): SafeString {
	const out: string[] = [];
	for (const a of args) pushClasses(out, a);
	return new SafeString(out.join(" "));
}

function htmlSafe(value: unknown): SafeString {
	return new SafeString(str(value));
}

/**
 * Render a value for debugging.
 *
 * The result is a SafeString, so its contents are ESCAPED first. Edge does the
 * same (`htmlSafe(inspect.string.html(value))`) and the reason is not cosmetic:
 * `inspect` is pointed at real records, and a record field holding
 * `<img onerror=…>` would otherwise execute — a stored XSS reachable from any
 * debug view left in a template.
 */
function inspect(value: unknown): SafeString {
	let json: string;
	try {
		json = JSON.stringify(value, null, 2);
	} catch {
		json = String(value);
	}
	return new SafeString(htmlEscape(json ?? "undefined"));
}

// The 8 characters inker escapes in `{{ }}` — `html.escape` uses the SAME set
// so an explicit escape can never be weaker than the implicit one. Edge escapes
// five; the three extra (backtick, U+2028, U+2029) only ever close more holes.
const ESCAPE_RE = /[&<>"'`\u2028\u2029]/g;
const ESCAPE_MAP: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
	"`": "&#96;",
	"\u2028": "&#x2028;",
	"\u2029": "&#x2029;",
};

/** Escape a value for HTML. A `SafeString` passes through untouched, which is
 * what makes it safe to call on a value that may already have been marked. */
function htmlEscape(value: unknown): string {
	if (value instanceof SafeString) return value.value;
	return str(value).replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/**
 * Serialize a value for embedding inside a `<script>` block. Plain
 * `JSON.stringify` is not enough there: a `</script>` inside a string would
 * close the tag, and U+2028/U+2029 are literal line terminators to a JS parser
 * even though JSON allows them raw.
 */
function jsStringify(value: unknown): SafeString {
	const json = JSON.stringify(value) ?? "undefined";
	return new SafeString(
		json
			.replace(/</g, "\\u003C")
			.replace(/>/g, "\\u003E")
			.replace(/&/g, "\\u0026")
			.replace(/\u2028/g, "\\u2028")
			.replace(/\u2029/g, "\\u2029"),
	);
}

/** Inker's built-in globals, keyed for injection into every expression scope. */
export const INKER_GLOBALS: Readonly<Record<string, unknown>> = Object.freeze({
	camelCase,
	pascalCase,
	snakeCase,
	dashCase,
	capitalCase,
	sentenceCase,
	dotCase,
	noCase,
	titleCase,
	truncate,
	excerpt,
	nl2br,
	pluralize,
	sentence,
	prettyBytes,
	toBytes,
	prettyMs,
	toMs,
	ordinal,
	inspect,
	html: Object.freeze({
		attrs: htmlAttrs,
		classNames,
		safe: htmlSafe,
		escape: htmlEscape,
	}),
	js: Object.freeze({ stringify: jsStringify }),
});

/** Bare-callable global names (everything except the `html` namespace object),
 * declared to the parser so `{{ camelCase(x) }}` is recognized as a call rather
 * than an unknown-helper parse error. `html.attrs(...)` is a method call → `Raw`,
 * so `html` needs no registration. */
export const INKER_GLOBAL_NAMES: readonly string[] = Object.keys(
	INKER_GLOBALS,
).filter((k) => k !== "html" && k !== "js");
