import { describe, expect, it } from "vitest";
import { INKER_GLOBALS } from "../../src/globals.js";

// Expected values are edge.js 6.5.1's `globals.truncate` / `globals.excerpt`
// on the same arguments (computed by running Edge).

function call(name: "truncate" | "excerpt", ...args: unknown[]): unknown {
	const fn = Reflect.get(INKER_GLOBALS, name);
	if (typeof fn !== "function") throw new Error(`${name} global missing`);
	return Reflect.apply(fn, undefined, args);
}

const EDGE: readonly [
	"truncate" | "excerpt",
	string,
	number,
	Record<string, unknown> | null,
	string,
][] = [
	["truncate", "<b>hello world</b>", 5, null, "<b>hello</b>..."],
	["truncate", "<b>hello world</b>", 5, { strict: true }, "<b>hello</b>..."],
	["truncate", "<p>one two</p><p>three four</p>", 6, null, "<p>one two...</p>"],
	["truncate", "<p>one two three</p>", 3, { strict: true }, "<p>one...</p>"],
	["truncate", "a <br/> b c d e f g", 3, null, "a <br/> ..."],
	[
		"truncate",
		"<div><img src=x>hello there friend</div>",
		7,
		null,
		"<div><img src=x>hello there</div>...",
	],
	["truncate", "x <!-- c --> yz abc def", 4, null, "x <!-- c --> yz..."],
	["truncate", "a < b and more text here", 3, null, "a < b and more text here"],
	["truncate", "short <b>x</b>", 50, null, "short <b>x</b>"],
	["truncate", "<i>abc</i>", 3, null, "<i>abc</i>..."],
	["excerpt", "one\n\ntwo three four", 5, null, "one two..."],
	["excerpt", "one\ntwo\n\nthree four five", 9, null, "one\ntwo three..."],
	["excerpt", "<p>one</p>\n\n<p>two three</p>", 5, null, "one two..."],
	["excerpt", "a < b", 100, null, "a"],
	["excerpt", "x <b>y</b> <", 100, null, "x y"],
	["excerpt", "<p>hello <b>world</b></p>", 100, null, "hello world"],
	["excerpt", "a<br>b<br />c <!-- x --> d", 100, null, "a b c  d"],
	["excerpt", "<>a</> b", 100, null, "a b"],
	["excerpt", "line1\r\n\r\nline2 more", 6, null, "line1 line..."],
	["excerpt", "<!-- open\nclose --> t", 100, null, "t"],
	[
		"excerpt",
		"para one here\n\npara two here",
		100,
		null,
		"para one here para two here",
	],
	[
		"excerpt",
		"para one here\n\npara two here",
		16,
		{ strict: true },
		"para one here par...",
	],
];

describe("truncate / excerpt match Edge", () => {
	it.each(EDGE)("%s(%j, %i, %j)", (name, value, length, options, expected) => {
		expect(call(name, value, length, options ?? undefined)).toBe(expected);
	});
});

// Edge's truncatise reads `<br/>` as a tag named `br/`, misses it in its
// void list and pops the parent, so the parent is never re-closed. inker
// tells `</tag>` from `<tag/>` and only pops the tag a closer names.
describe("truncate keeps the tag stack across self-closing tags", () => {
	it.each([
		["<b>hello<br/> world again</b>", 8, "<b>hello<br/> world</b>..."],
		["<p>one<img/>two three four</p>", 6, "<p>one<img/>two...</p>"],
		["<div>a<hr/>bc de fg</div>", 3, "<div>a<hr/>bc</div>..."],
		["<b>a<BR/>bc de fg</b>", 3, "<b>a<BR/>bc</b>..."],
		["<b>a<img src=x />bc de fg</b>", 3, "<b>a<img src=x />bc</b>..."],
		[
			'<b>x<svg><path d="M0"/></svg> yz more</b>',
			3,
			'<b>x<svg><path d="M0"/></svg> yz</b>...',
		],
		["<b>a<span/>bc de fg</b>", 3, "<b>a<span/>bc</b>..."],
	])("truncate(%j, %i)", (value, length, expected) => {
		expect(call("truncate", value, length)).toBe(expected);
	});

	it("ignores a closer that names no open tag", () => {
		expect(call("truncate", "<b>a</i> bc de</b>", 3)).toBe(
			"<b>a</i> bc</b>...",
		);
	});

	it("closes the tags a closer skips over", () => {
		expect(call("truncate", "<b><i>a</b> bc de", 3)).toBe("<b><i>a</b> bc...");
	});
});

// A wall-clock ceiling measures the machine as much as the algorithm: CI
// runners under v8 coverage missed a 100 ms bound on input that runs in 30 ms
// locally. What separates linear from quadratic is how the time grows, so each
// case times n and 4n (best of three after a warm-up) and bounds the ratio:
// about 4 when linear, about 16 when quadratic.
describe("truncate / excerpt stay linear on hostile input", () => {
	const MAX_GROWTH = 10;

	function best(name: "truncate" | "excerpt", input: string): number {
		call(name, input, 20);
		let fastest = Number.POSITIVE_INFINITY;
		for (let run = 0; run < 3; run++) {
			const started = performance.now();
			call(name, input, 20);
			fastest = Math.min(fastest, performance.now() - started);
		}
		return fastest;
	}

	function growth(
		name: "truncate" | "excerpt",
		make: (n: number) => string,
		n: number,
	): number {
		const small = best(name, make(n));
		const large = best(name, make(4 * n));
		// Below half a millisecond the timer's own noise dominates the ratio.
		return large / Math.max(small, 0.5);
	}

	it.each<[string, (n: number) => string, number]>([
		["unclosed '<'", (n) => "<".repeat(n), 50_000],
		["'<>' pairs", (n) => "<>".repeat(n), 25_000],
		["unclosed comments on one line", (n) => "<!--".repeat(n), 12_500],
		[
			"a long line before a single line break",
			(n) => `${"a".repeat(n)}\nb\n\nc`,
			50_000,
		],
	])("excerpt of %s", (_label, make, n) => {
		expect(growth("excerpt", make, n)).toBeLessThan(MAX_GROWTH);
	});

	it("truncate of a long tag-heavy string", () => {
		expect(growth("truncate", (n) => "<b>".repeat(n), 25_000)).toBeLessThan(
			MAX_GROWTH,
		);
	});

	it("truncate of many open tags followed by closers naming none of them", () => {
		expect(
			growth(
				"truncate",
				(n) => `${"<b>".repeat(n)}${"</i>".repeat(n)}`,
				12_500,
			),
		).toBeLessThan(MAX_GROWTH);
	});
});
