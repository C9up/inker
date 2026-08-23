import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InkerRenderError } from "../../src/InkerRenderError.js";
import { Templates } from "../../src/Templates.js";
import { asTyped } from "../__helpers__/bypass-type-check.js";

// 62-2: full-JS Edge expression grammar via the embedded QuickJS VM. These
// forms were REJECTED by the restricted grammar; they now evaluate as real JS.
describe("Templates — full-JS expressions (62-2 Edge parity)", () => {
	let root: string;

	beforeEach(() => {
		root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "inker-fulljs-")),
		);
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const render = (
		src: string,
		data: Record<string, unknown>,
	): Promise<string> => {
		fs.writeFileSync(path.join(root, "t.inker"), src);
		return new Templates({ root, cacheMode: "mtime" }).render("t", data);
	};

	it("method call + array method + arrow fn in interpolation", async () => {
		const out = await render("{{ items.map(i => i.n).join('-') }}", {
			items: [{ n: 1 }, { n: 2 }, { n: 3 }],
		});
		expect(out).toBe("1-2-3");
	});

	it("ternary conditional", async () => {
		expect(await render("{{ n > 1 ? 'many' : 'one' }}", { n: 5 })).toBe("many");
		expect(await render("{{ n > 1 ? 'many' : 'one' }}", { n: 1 })).toBe("one");
	});

	it("arithmetic", async () => {
		expect(
			await render("{{ items.length * price }}", {
				items: [1, 2, 3],
				price: 4,
			}),
		).toBe("12");
	});

	it("array literal + reduce", async () => {
		expect(
			await render("{{ [1, 2, 3, 4].reduce((s, x) => s + x, 0) }}", {}),
		).toBe("10");
	});

	it("rich expression drives an @if condition", async () => {
		const src = "@if(users.filter(u => u.active).length > 0)some@else@endif";
		expect(
			await render(src, { users: [{ active: false }, { active: true }] }),
		).toBe("some");
		expect(await render(src, { users: [{ active: false }] })).toBe("");
	});

	it("full-JS results are still HTML-escaped by {{ }}", async () => {
		const out = await render("{{ tags.join(', ') }}", { tags: ["<a>", "<b>"] });
		expect(out).toBe("&lt;a&gt;, &lt;b&gt;");
	});

	it("still rejects prototype-pollution object keys at parse (security preserved)", async () => {
		try {
			await render("{{ ({ __proto__: 1 }) }}", {});
			expect.fail("expected a parse rejection");
		} catch (e) {
			const err = asTyped<InkerRenderError>(e);
			expect(err.code).toBe("E_INKER_INVALID_EXPRESSION");
		}
	});

	it("@let object destructuring binds through the real Templates path", async () => {
		const out = await render(
			"@let({ name, role } = user){{ name }}/{{ role }}",
			{
				user: { name: "Ada", role: "admin" },
			},
		);
		expect(out).toBe("Ada/admin");
	});

	it("@let array destructuring with rest + computed reduce still works", async () => {
		const out = await render(
			"@let([head, ...tail] = xs)@let(sum = tail.reduce((s, n) => s + n, 0)){{ head }}+{{ sum }}",
			{ xs: [10, 1, 2, 3] },
		);
		expect(out).toBe("10+6");
	});

	// NOTE (62-2 Node pivot): expressions now evaluate in Node's own V8, not a
	// sandboxed QuickJS VM. Templates are author-controlled (`.inker` files) — the
	// same trust level as the rest of the app's code — exactly like Adonis Edge,
	// which also runs template code in the host runtime with no sandbox. There is
	// therefore no prototype-freeze here; the earlier QuickJS-sandbox assertion is
	// obsolete and was removed (it also mutated the test process's Array.prototype).
});
