import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { InkerTag } from "../../src/renderNode.js";
import { Templates } from "../../src/Templates.js";

// Expected outputs are what edge.js 6.5.1 renders for the same source.

function engine(): Templates {
	return new Templates({ root: os.tmpdir() });
}

function render(source: string, data: Record<string, unknown> = {}): string {
	return engine().renderString(source, data);
}

describe("the generic @end closer", () => {
	it("closes @if, with or without @else", () => {
		expect(render("@if(true)\nyes\n@end\nafter")).toBe("yes\nafter");
		expect(render("@if(false)yes@else\nno@end")).toBe("no");
		expect(render("@if(a)A@elseif(b)B@end", { b: true })).toBe("B");
	});

	it("closes @unless and @each", () => {
		expect(render("@unless(false)u@end")).toBe("u");
		expect(render("<ul>\n@each(x in [1,2])\n<li>{{x}}</li>\n@end\n</ul>")).toBe(
			"<ul>\n<li>1</li>\n<li>2</li>\n</ul>",
		);
	});

	it("closes the innermost block when blocks nest", () => {
		expect(render("@each(x in [1,2])@if(x > 1)[{{ x }}]@end@end", {})).toBe(
			"[2]",
		);
	});

	it("closes @pushTo and @pushOnceTo", () => {
		expect(render("@pushTo('s')a@end@pushOnceTo('s')b@end[@stack('s')]")).toBe(
			"[ab]",
		);
	});

	it("closes a custom block tag", () => {
		const t = engine();
		const tag: InkerTag = {
			tagName: "box",
			block: true,
			seekable: false,
			compile(_parser, buffer, token) {
				const body = token.renderBody();
				buffer.writeRaw(`<box>${typeof body === "string" ? body : ""}</box>`);
			},
		};
		t.registerTag(tag);
		expect(t.renderString("@box\nx\n@end")).toBe("<box>x\n</box>");
	});

	it("closes @component and @slot", async () => {
		const root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "inker-end-")),
		);
		fs.mkdirSync(path.join(root, "components"));
		fs.writeFileSync(
			path.join(root, "components", "card.inker"),
			"<h>{{{ $slots.title ? $slots.title() : '' }}}</h>{{{ $slots.main() }}}",
		);
		fs.writeFileSync(
			path.join(root, "page.inker"),
			"@component('card')@slot('title')T@end@if(true)B@end@end",
		);
		fs.writeFileSync(
			path.join(root, "nested.inker"),
			"@component('card')@component('card')in@end@end",
		);
		const t = new Templates({ root });
		expect(await t.render("page")).toBe("<h>T</h>B");
		expect(await t.render("nested")).toBe("<h></h><h></h>in");
	});

	it("keeps the named closers working", () => {
		expect(render("@if(true)yes@endif")).toBe("yes");
	});

	it("rejects @end with nothing open", () => {
		expect(() => render("x@end")).toThrow(/@end/);
	});

	it("leaves an e-mail address that contains @end alone", () => {
		expect(render("mail me@end.org")).toBe("mail me@end.org");
	});
});

describe("the ~ newline trim marker", () => {
	it("drops the newline after a closing tag", () => {
		expect(render("@if(true)\nyes\n@endif~\nafter")).toBe("yesafter");
		expect(render("@if(true)~\nyes\n@end~\nafter")).toBe("yesafter");
	});

	it("is a no-op on an opening tag at the top of the template", () => {
		expect(render("@if(true)~\nyes\n@endif\nafter")).toBe("yes\nafter");
	});

	it("drops the newline leading into an opened block", () => {
		expect(render("a\n@if(true)~\nyes\n@endif\nafter")).toBe("ayes\nafter");
	});

	it("drops the newline before each iteration of a loop", () => {
		expect(
			render("<ul>\n@each(x in [1,2])~\n<li>{{x}}</li>\n@end\n</ul>"),
		).toBe("<ul><li>1</li><li>2</li>\n</ul>");
		expect(
			render("<ul>\n@each(x in [1,2])\n<li>{{x}}</li>\n@end~\n</ul>"),
		).toBe("<ul>\n<li>1</li>\n<li>2</li></ul>");
		expect(
			render("<ul>\n@each(x in [1,2])~\n<li>{{x}}</li>\n@end~\n</ul>"),
		).toBe("<ul><li>1</li><li>2</li></ul>");
	});

	it("works on an inline tag", () => {
		expect(render("a\n@let(x = 1)~\nb{{ x }}")).toBe("ab1");
		expect(render("@let(a = 1)~\nx{{a}}\ny")).toBe("x1\ny");
	});

	it("is literal text anywhere but at the end of a tag line", () => {
		expect(render("@if(true)~yes@endif")).toBe("~yes");
		expect(render("a ~\nb")).toBe("a ~\nb");
	});
});
