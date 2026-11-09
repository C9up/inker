import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";

// Newline handling follows Edge's line-based lexer. Every expected value was
// produced by edge.js 6.5.1 rendering the same files (component names carry
// Edge's `components/` prefix there; inker resolves them under it already).

interface Case {
	readonly name: string;
	readonly page: string;
	readonly files: Readonly<Record<string, string>>;
	readonly data: Readonly<Record<string, unknown>>;
	readonly expected: string;
}

const CASES: readonly Case[] = [
	{
		name: "if-true",
		page: "@if(a)\nyes\n@else\nno\n@endif\nafter",
		files: {},
		data: {
			a: true,
		},
		expected: "yes\nafter",
	},
	{
		name: "if-false",
		page: "@if(a)\nyes\n@else\nno\n@endif\nafter",
		files: {},
		data: {
			a: false,
		},
		expected: "no\nafter",
	},
	{
		name: "elseif",
		page: "start\n@if(n === 1)\none\n@elseif(n === 2)\ntwo\n@else\nmany\n@endif\nend\n",
		files: {},
		data: {
			n: 2,
		},
		expected: "start\ntwo\nend",
	},
	{
		name: "each",
		page: "<ul>\n@each(x in xs)\n  <li>{{ x }}</li>\n@endeach\n</ul>\n",
		files: {},
		data: {
			xs: [1, 2],
		},
		expected: "<ul>\n  <li>1</li>\n  <li>2</li>\n</ul>",
	},
	{
		name: "each-else",
		page: "<ul>\n@each(x in xs)\n  <li>{{ x }}</li>\n@else\n  <li>none</li>\n@endeach\n</ul>",
		files: {},
		data: {
			xs: [],
		},
		expected: "<ul>\n  <li>none</li>\n</ul>",
	},
	{
		name: "each-index",
		page: "@each((x, i) in xs)\n{{ i }}:{{ x }}\n@end",
		files: {},
		data: {
			xs: ["a", "b"],
		},
		expected: "0:a\n1:b",
	},
	{
		name: "let",
		page: "a\n@let(x = 1)\nb{{ x }}\n",
		files: {},
		data: {},
		expected: "ab1",
	},
	{
		name: "let-twice",
		page: "@let(a = 1)\n@let(b = 2)\n{{ a }}{{ b }}",
		files: {},
		data: {},
		expected: "12",
	},
	{
		name: "let-then-if",
		page: "@let(a = 1)\n@if(a)\nyes\n@endif\nz",
		files: {},
		data: {},
		expected: "yes\nz",
	},
	{
		name: "assign",
		page: "@let(n = 1)\n@assign(n = 2)\nvalue {{ n }}\n",
		files: {},
		data: {},
		expected: "value 2",
	},
	{
		name: "eval",
		page: "a\n@eval(1)\nb",
		files: {},
		data: {},
		expected: "ab",
	},
	{
		name: "tags-back-to-back",
		page: "@if(true)\nA\n@endif\n@if(true)\nB\n@endif\nC",
		files: {},
		data: {},
		expected: "A\nB\nC",
	},
	{
		name: "include",
		page: "start\n@include('partials/p')\nend\n",
		files: {
			"partials/p": "P line1\nP line2\n",
		},
		data: {},
		expected: "startP line1\nP line2\n\nend",
	},
	{
		name: "include-twice",
		page: "@include('partials/q')\n@include('partials/q')\nz",
		files: {
			"partials/q": "Q\n",
		},
		data: {},
		expected: "Q\n\nQ\n\nz",
	},
	{
		name: "include-if",
		page: "a\n@includeIf(true, 'partials/q')\nb",
		files: {
			"partials/q": "Q\n",
		},
		data: {},
		expected: "aQ\n\nb",
	},
	{
		name: "component-slots",
		page: "@component('card', { title: 'T' })\n  body line\n  @slot('footer')\n    F\n  @endslot\n@endcomponent\nafter",
		files: {
			"components/card":
				"<div>\n  <h>{{ title }}</h>\n  {{{ await $slots.main() }}}\n  {{{ await $slots.footer() }}}\n</div>\n",
		},
		data: {},
		expected: "<div>\n  <h>T</h>\n    body line\n      F\n</div>\n\nafter",
	},
	{
		name: "component-self",
		page: "a\n@!component('c2', { x: 1 })\nb",
		files: {
			"components/c2": "[{{ x }}]\n",
		},
		data: {},
		expected: "a[1]\n\nb",
	},
	{
		name: "component-main-only",
		page: "@component('w')\n\nhello\n@end",
		files: {
			"components/w": "<w>{{{ await $slots.main() }}}</w>",
		},
		data: {},
		expected: "<w>\nhello</w>",
	},
	{
		name: "push-once",
		page: "@stack('js')\nbody\n@pushOnceTo('js')\n<script>a</script>\n@endpushOnceTo\n@pushTo('js')\n<script>b</script>\n@endpushTo\nend",
		files: {},
		data: {},
		expected: "<script>a</script>\n<script>b</script>\nbody\nend",
	},
	{
		name: "comments",
		page: "a\n{{-- c --}}\nb\n{{-- multi\nline --}}\nc",
		files: {},
		data: {},
		expected: "a\n\nb\n\nc",
	},
	{
		name: "comment-inline",
		page: "a {{-- c --}} b\nc",
		files: {},
		data: {},
		expected: "a  b\nc",
	},
	{
		name: "tilde-open",
		page: "a\n@if(true)~\nyes\n@endif\nafter",
		files: {},
		data: {},
		expected: "ayes\nafter",
	},
	{
		name: "tilde-close",
		page: "@if(true)\nyes\n@end~\nafter",
		files: {},
		data: {},
		expected: "yesafter",
	},
	{
		name: "tilde-each",
		page: "<ul>\n@each(x in [1,2])~\n<li>{{x}}</li>\n@end~\n</ul>",
		files: {},
		data: {},
		expected: "<ul><li>1</li><li>2</li></ul>",
	},
	{
		name: "tilde-let",
		page: "a\n@let(x = 1)~\nb",
		files: {},
		data: {},
		expected: "ab",
	},
	{
		name: "blank-lines",
		page: "\n\nhello\n\n",
		files: {},
		data: {},
		expected: "\nhello\n",
	},
	{
		name: "indent",
		page: "<div>\n  @if(true)\n    <p>x</p>\n  @endif\n</div>",
		files: {},
		data: {},
		expected: "<div>\n    <p>x</p>\n</div>",
	},
	{
		name: "crlf",
		page: "a\r\n@if(true)\r\nb\r\n@endif\r\nc\r\n",
		files: {},
		data: {},
		expected: "a\nb\nc",
	},
	{
		name: "mustache-multiline",
		page: "x {{\n  a\n}} y\nz",
		files: {},
		data: {
			a: 1,
		},
		expected: "x 1 y\nz",
	},
	{
		name: "nested",
		page: "@each(x in xs)\n  @if(x > 1)\n    big {{ x }}\n  @else\n    small {{ x }}\n  @endif\n@endeach\ndone",
		files: {},
		data: {
			xs: [1, 2],
		},
		expected: "\n    small 1\n\n    big 2\ndone",
	},
	{
		name: "multiline-args",
		page: "a\n@if(\n  true\n)\nb\n@endif\nc",
		files: {},
		data: {},
		expected: "a\nb\nc",
	},
	{
		name: "text-only",
		page: "line1\nline2",
		files: {},
		data: {},
		expected: "line1\nline2",
	},
	{
		name: "unless",
		page: "@unless(false)\nu\n@endunless\nz",
		files: {},
		data: {},
		expected: "u\nz",
	},
];

function engineFor(c: Case): Templates {
	const root = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-newlines-")),
	);
	for (const [name, source] of Object.entries({ ...c.files, page: c.page })) {
		const file = path.join(root, `${name}.inker`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, source);
	}
	return new Templates({ root, cacheMode: "never" });
}

describe("newlines match Edge byte for byte", () => {
	it.each(CASES)("$name", async (c) => {
		expect(await engineFor(c).render("page", c.data)).toBe(c.expected);
	});
});

describe("newlines around registered tags", () => {
	function engineWithTags(): Templates {
		const t = new Templates({ root: os.tmpdir() });
		t.registerTag({
			tagName: "note",
			block: false,
			seekable: true,
			noNewLine: true,
			compile: (_parser, buffer) => buffer.writeRaw("N"),
		});
		t.registerTag({
			tagName: "mark",
			block: false,
			seekable: true,
			compile: (_parser, buffer) => buffer.writeRaw("M"),
		});
		return t;
	}

	// Expected values from edge.js 6.5.1 with the same two tags registered.
	it.each([
		["a\n@note('x')\nb", "aNb"],
		["a\n@mark('x')\nb", "aM\nb"],
		["@mark('x')\n@mark('y')\nz", "M\nM\nz"],
	])("%j", (source, expected) => {
		expect(engineWithTags().renderString(source)).toBe(expected);
	});
});

describe("a space before a tag's parenthesis", () => {
	it("is accepted, as Edge accepts up to two", () => {
		// edge.js 6.5.1 renders "a\nb" for this source.
		expect(
			new Templates({ root: os.tmpdir() }).renderString(
				"a\n@if (true)\nb\n@endif",
			),
		).toBe("a\nb");
	});
});

describe("tags written mid-line (inker extension)", () => {
	it("leave the line breaks of the line alone", () => {
		const t = new Templates({ root: os.tmpdir() });
		expect(t.renderString("a @let(x = 1)b{{ x }}\nc")).toBe("a b1\nc");
		expect(t.renderString("@if(true)yes@endif\nafter")).toBe("yes\nafter");
	});

	it("whitespace control still crosses line breaks", () => {
		const t = new Templates({ root: os.tmpdir() });
		expect(t.renderString("a\n\n{{- 'b' }}")).toBe("ab");
		expect(t.renderString("{{ 'a' -}}\n\n  b")).toBe("ab");
	});
});
