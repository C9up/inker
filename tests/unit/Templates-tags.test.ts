import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SafeString } from "../../src/index.js";
import { Templates } from "../../src/Templates.js";

function makeTempRoot(): string {
	return fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-tags-")),
	);
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
				buffer.outputExpression(
					`${token.properties.jsArg}.toUpperCase()`,
					token.filename,
					1,
					true,
				);
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
			tpl.registerTag({
				tagName: "1bad",
				block: false,
				seekable: true,
				compile() {},
			}),
		).toThrow(/E_INKER_INVALID_PATH|1bad/);
	});

	it("rejects overriding a built-in directive", () => {
		const tpl = new Templates({ root });
		expect(() =>
			tpl.registerTag({
				tagName: "if",
				block: false,
				seekable: true,
				compile() {},
			}),
		).toThrow(/built-in|E_INKER_INVALID_PATH/);
	});

	it("rejects built-ins the lexer knows but were once missing from the blocklist (unless/endunless/includeIf)", () => {
		// These are `is_block_keyword` in the Rust lexer; registering them would
		// have sat silently inert before the blocklist was completed.
		const tpl = new Templates({ root });
		for (const name of ["unless", "endunless", "includeIf"]) {
			expect(() =>
				tpl.registerTag({
					tagName: name,
					block: false,
					seekable: true,
					compile() {},
				}),
			).toThrow(/built-in|E_INKER_INVALID_PATH/);
		}
	});

	it("wraps a body when the tag is registered block: true", () => {
		const tpl = new Templates({ root });
		tpl.registerTag({
			tagName: "card",
			block: true,
			seekable: true,
			compile(_parser, buffer, token) {
				buffer.writeRaw(`<div class=${token.properties.jsArg}>`);
				buffer.writeRaw(String(token.renderBody()));
				buffer.writeRaw("</div>");
			},
		});
		expect(tpl.renderString("@card('lead')hello@endcard")).toBe(
			"<div class='lead'>hello</div>",
		);
	});

	it("renders a block tag's body in the surrounding scope", () => {
		const tpl = new Templates({ root });
		tpl.registerTag({
			tagName: "box",
			block: true,
			seekable: false,
			compile(_p, buffer, token) {
				buffer.writeRaw(`[${String(token.renderBody())}]`);
			},
		});
		expect(tpl.renderString("@let(n = 3)@box(){{ n }}@endbox")).toBe("[3]");
	});

	it("skips the body entirely when the tag never renders it", () => {
		let evaluated = 0;
		// A registered HELPER, not data: the parser validates call positions
		// against the helper set, so a bare `tick()` in data would not parse.
		const tpl = new Templates({
			root,
			helpers: new Map([
				[
					"tick",
					() => {
						evaluated += 1;
						return "";
					},
				],
			]),
		});
		tpl.registerTag({
			tagName: "hidden",
			block: true,
			seekable: false,
			compile() {
				// deliberately never calls renderBody()
			},
		});
		const out = tpl.renderString("@hidden(){{ tick() }}@endhidden");
		expect(out).toBe("");
		expect(evaluated).toBe(0);
	});

	it("accepts the explicit self-closing @!name form for a block tag", () => {
		const tpl = new Templates({ root });
		tpl.registerTag({
			tagName: "rule",
			block: true,
			seekable: false,
			compile(_p, buffer, token) {
				buffer.writeRaw(`<hr>${String(token.renderBody())}`);
			},
		});
		expect(tpl.renderString("a@!rule()b")).toBe("a<hr>b");
	});

	it("requires the matching @end and will not cross two block tags", () => {
		const tpl = new Templates({ root });
		for (const tagName of ["outer", "inner"]) {
			tpl.registerTag({
				tagName,
				block: true,
				seekable: false,
				compile(_p, buffer, token) {
					buffer.writeRaw(String(token.renderBody()));
				},
			});
		}
		expect(() => tpl.renderString("@outer()x@endinner")).toThrow(
			/does not match open @outer/,
		);
		expect(() => tpl.renderString("@outer()x")).toThrow(/never closed/);
		expect(tpl.renderString("@outer()a@inner()b@endinner c@endouter")).toBe(
			"ab c",
		);
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
				buffer.writeRaw(
					new SafeString(`[${token.properties.jsArg.replace(/['"]/g, "")}]`)
						.value,
				);
			},
		});
		expect(await tpl.render("b", {})).toBe("[hi]");
	});

	it("renders the body only when the check passes", async () => {
		const tpl = new Templates({ root });
		fs.writeFileSync(
			path.join(root, "gate.inker"),
			"@can('post.edit')YES@endcan@can('post.delete')NO@endcan",
		);
		tpl.registerTag({
			tagName: "can",
			block: true,
			seekable: true,
			async compile(_p, buffer, token) {
				const allowed = await Promise.resolve(
					token.properties.jsArg.includes("edit"),
				);
				if (allowed) buffer.writeRaw(await token.renderBody());
			},
		});
		expect(await tpl.render("gate")).toBe("YES");
	});

	it("reads the render scope through token.evaluate", async () => {
		const tpl = new Templates({ root });
		fs.writeFileSync(
			path.join(root, "scoped.inker"),
			"@gate('post.edit')SECRET@endgate",
		);
		tpl.registerTag({
			tagName: "gate",
			block: true,
			seekable: true,
			async compile(_p, buffer, token) {
				// The shape an authorization tag needs: find the request's
				// checker in scope, then resolve its own arguments there too.
				const checker = token.evaluate("bouncer");
				const args = token.evaluate(`[${token.properties.jsArg}]`);
				const allows = Reflect.get(Object(checker), "allows");
				const ok = await allows.apply(checker, Array.isArray(args) ? args : []);
				if (ok) buffer.writeRaw(await token.renderBody());
			},
		});
		const bouncer = {
			allows: (ability: string) => Promise.resolve(ability === "post.edit"),
		};
		expect(await tpl.render("scoped", { bouncer })).toBe("SECRET");
		const denying = { allows: () => Promise.resolve(false) };
		expect(await tpl.render("scoped", { bouncer: denying })).toBe("");
	});

	it("binds locals into the body, the way @error binds $message", async () => {
		const tpl = new Templates({ root });
		fs.writeFileSync(
			path.join(root, "bound.inker"),
			"@note('email')[{{ $message }}]@endnote",
		);
		tpl.registerTag({
			tagName: "note",
			block: true,
			seekable: true,
			compile(_p, buffer, token) {
				const key = token.evaluate(token.properties.jsArg);
				buffer.writeRaw(
					String(token.renderBody({ $message: `about ${String(key)}` })),
				);
			},
		});
		expect(await tpl.render("bound")).toBe("[about email]");
	});

	it("keeps a bound local scoped to the body", async () => {
		const tpl = new Templates({ root });
		fs.writeFileSync(
			path.join(root, "leak.inker"),
			"@note()x@endnote{{ typeof $message }}",
		);
		tpl.registerTag({
			tagName: "note",
			block: true,
			seekable: false,
			compile(_p, buffer, token) {
				buffer.writeRaw(String(token.renderBody({ $message: "inner" })));
			},
		});
		expect(await tpl.render("leak")).toBe("xundefined");
	});

	it("raises on the synchronous render path", () => {
		const tpl = new Templates({ root });
		tpl.registerTag({
			tagName: "slow",
			block: true,
			seekable: false,
			async compile(_p, buffer) {
				await Promise.resolve();
				buffer.writeRaw("x");
			},
		});
		expect(() => tpl.renderString("@slow()a@endslow")).toThrow(
			/cannot use `await`/,
		);
	});
});
