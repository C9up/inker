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

describe("truncate / excerpt stay linear on hostile input", () => {
	function timed(fn: () => unknown): number {
		const started = performance.now();
		fn();
		return performance.now() - started;
	}

	it.each([
		["unclosed '<'", "<".repeat(200_000)],
		["'<>' pairs", "<>".repeat(100_000)],
		["unclosed comments on one line", "<!--".repeat(50_000)],
		[
			"a long line before a single line break",
			`${"a".repeat(200_000)}\nb\n\nc`,
		],
	])("excerpt of %s", (_label, hostile) => {
		expect(timed(() => call("excerpt", hostile, 20))).toBeLessThan(100);
	});

	it("truncate of a long tag-heavy string", () => {
		expect(
			timed(() => call("truncate", "<b>".repeat(100_000), 20)),
		).toBeLessThan(100);
	});
});
