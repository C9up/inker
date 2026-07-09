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

function titleCase(value: unknown): string {
	return words(str(value)).map(cap).join(" ");
}

// ---- string manipulation ----

interface TruncateOptions {
	readonly suffix?: string;
	readonly completeWords?: boolean;
}

function truncate(value: unknown, length = 20, options: TruncateOptions = {}): string {
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

function excerpt(value: unknown, length = 20, options: TruncateOptions = {}): string {
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
	const rounded = exp === 0 ? String(scaled) : scaled.toFixed(2).replace(/\.?0+$/, "");
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

function inspect(value: unknown): SafeString {
	let json: string;
	try {
		json = JSON.stringify(value, null, 2);
	} catch {
		json = String(value);
	}
	return new SafeString(json ?? "undefined");
}

/** The Edge-core globals, keyed for injection into every expression scope. */
export const EDGE_GLOBALS: Readonly<Record<string, unknown>> = Object.freeze({
	camelCase,
	pascalCase,
	snakeCase,
	dashCase,
	titleCase,
	truncate,
	excerpt,
	nl2br,
	pluralize,
	prettyBytes,
	prettyMs,
	ordinal,
	inspect,
	html: Object.freeze({ attrs: htmlAttrs, classNames, safe: htmlSafe }),
});

/** Bare-callable global names (everything except the `html` namespace object),
 * declared to the parser so `{{ camelCase(x) }}` is recognized as a call rather
 * than an unknown-helper parse error. `html.attrs(...)` is a method call → `Raw`,
 * so `html` needs no registration. */
export const EDGE_GLOBAL_NAMES: readonly string[] = Object.keys(EDGE_GLOBALS).filter(
	(k) => k !== "html",
);
