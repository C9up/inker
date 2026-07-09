import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SafeString } from "../../src/index.js";
import { Templates } from "../../src/Templates.js";

function makeTempRoot(): string {
	return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "inker-tags-")));
}

describe("Templates — registerTag (Edge custom tags)", () => {
	let root: string;
	beforeEach(() => {
		root = makeTempRoot();
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("renders a registered `@tagName(jsArg)` on disk via buffer.writeRaw", async () => {
		const tpl = new Templates({ root });
		tpl.registerTag({
			tagName: "svg",
			block: false,
			seekable: true,
			compile(_parser, buffer, token) {
				const name = token.properties.jsArg.trim().replace(/['"]/g, "");
				buffer.writeRaw(`<svg data-icon="${name}"/>`);
			},
		});
		fs.writeFileSync(path.join(root, "page.inker"), "@svg('user')");
		expect(await tpl.render("page", {})).toBe('<svg data-icon="user"/>');
	});

	it("buffer.outputExpression evaluates a template expression in the render scope", async () => {
		const tpl = new Templates({ root });
		tpl.registerTag({
			tagName: "shout",
			block: false,
			seekable: true,
			compile(_parser, buffer, token) {
				buffer.outputExpression(`${token.properties.jsArg}.toUpperCase()`, token.filename, 1, true);
			},
		});
		fs.writeFileSync(path.join(root, "p.inker"), "@shout(name)");
		expect(await tpl.render("p", { name: "ada" })).toBe("ADA");
	});

	it("works through renderString too", () => {
		const tpl = new Templates({ root });
		tpl.registerTag({
			tagName: "hr",
			block: false,
			seekable: false,
			compile(_parser, buffer) {
				buffer.writeRaw("<hr/>");
			},
		});
		expect(tpl.renderString("a@hr()b", {})).toBe("a<hr/>b");
	});

	it("an unregistered `@tag` renders as literal text (not a custom tag)", () => {
		const tpl = new Templates({ root });
		expect(tpl.renderString("@svg('x')", {})).toBe("@svg('x')");
	});

	it("rejects an invalid tagName", () => {
		const tpl = new Templates({ root });
		expect(() =>
			tpl.registerTag({ tagName: "1bad", block: false, seekable: true, compile() {} }),
		).toThrow(/E_INKER_INVALID_PATH|1bad/);
	});

	it("rejects overriding a built-in directive", () => {
		const tpl = new Templates({ root });
		expect(() =>
			tpl.registerTag({ tagName: "if", block: false, seekable: true, compile() {} }),
		).toThrow(/built-in|E_INKER_INVALID_PATH/);
	});

	it("rejects a block custom tag (not supported yet)", () => {
		const tpl = new Templates({ root });
		expect(() =>
			tpl.registerTag({ tagName: "card", block: true, seekable: true, compile() {} }),
		).toThrow(/block custom tags|not supported/);
	});

	it("registering a tag invalidates a stale (pre-registration) parse", async () => {
		const tpl = new Templates({ root });
		fs.writeFileSync(path.join(root, "b.inker"), "@box('hi')");
		// First render — no tag registered → literal text, cached parse.
		expect(await tpl.render("b", {})).toBe("@box('hi')");
		// Now register: the cache must drop the stale parse and re-parse as a tag.
		tpl.registerTag({
			tagName: "box",
			block: false,
			seekable: true,
			compile(_parser, buffer, token) {
				buffer.writeRaw(new SafeString(`[${token.properties.jsArg.replace(/['"]/g, "")}]`).value);
			},
		});
		expect(await tpl.render("b", {})).toBe("[hi]");
	});
});
