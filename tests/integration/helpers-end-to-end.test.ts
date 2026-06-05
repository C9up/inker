import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HelperFn, SafeString, Templates } from "../../src/index.js";
import { asTyped } from "../__helpers__/bypass-type-check.js";

function makeTempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "inker-e2e-helpers-"));
}

function write(root: string, rel: string, content: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

describe("end-to-end — helpers + layouts + partials + components (53.4)", () => {
	let root: string;
	beforeEach(() => {
		root = makeTempRoot();
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function buildHelpers(): {
		helpers: Map<string, HelperFn>;
		calls: string[];
	} {
		const calls: string[] = [];
		const helpers = new Map<string, HelperFn>([
			[
				"t",
				(key, params) => {
					calls.push(`t:${String(key)}`);
					const dict: Record<string, string> = {
						greeting: "Hello",
						footer: "© 2026",
						"role.admin": "Administrator",
						"role.user": "Member",
					};
					const base = dict[String(key)] ?? `[missing:${String(key)}]`;
					if (
						params !== undefined &&
						params !== null &&
						typeof params === "object" &&
						"name" in params
					) {
						return `${base}, ${String(asTyped<{ name: string }>(params).name)}`;
					}
					return base;
				},
			],
			[
				"csrfField",
				() => {
					calls.push("csrfField");
					return new SafeString(
						'<input type="hidden" name="_csrf" value="TOKEN">',
					);
				},
			],
			[
				"url",
				(name, params) => {
					calls.push(`url:${String(name)}`);
					if (
						params !== undefined &&
						params !== null &&
						typeof params === "object" &&
						"id" in params
					) {
						return `/${String(name).replace(".", "/")}/${String(
							asTyped<{ id: number }>(params).id,
						)}`;
					}
					return `/${String(name).replace(".", "/")}`;
				},
			],
			[
				"asset",
				(name) => {
					calls.push(`asset:${String(name)}`);
					return `/assets/${String(name)}?h=abc`;
				},
			],
		]);
		return { helpers, calls };
	}

	it("composes layout + partial + component + helpers", async () => {
		write(
			root,
			"layouts/main.inker",
			[
				"<html><head>",
				"<title>{{ t('greeting') }}</title>",
				'<link rel="stylesheet" href="{{ asset(\'app.css\') }}">',
				"</head><body>",
				"{{> body }}",
				"<footer>{{ t('footer') }}</footer>",
				"</body></html>",
			].join("\n"),
		);
		write(
			root,
			"partials/user-row.inker",
			"<li><a href=\"{{ url('user.show', { id: user.id }) }}\">{{ user.name }}</a></li>",
		);
		write(
			root,
			"components/role-badge.inker",
			'<span class="badge">{{ t(label) }}</span>',
		);
		write(
			root,
			"index.inker",
			[
				"{% layout 'layouts/main' %}",
				"<form>{{ csrfField() }}</form>",
				"<ul>",
				"{% each users as user %}",
				"{% include 'partials/user-row' %}",
				"{% component 'role-badge' { label: user.role } %}",
				"{% endeach %}",
				"</ul>",
			].join("\n"),
		);

		const { helpers, calls } = buildHelpers();
		const tpl = new Templates({ root, helpers });
		const html = await tpl.render("index", {
			users: [
				{ id: 1, name: "Ada", role: "role.admin" },
				{ id: 2, name: "Bob", role: "role.user" },
			],
		});

		expect(html).toContain("<title>Hello</title>");
		expect(html).toContain(
			'<link rel="stylesheet" href="/assets/app.css?h=abc">',
		);
		expect(html).toContain('<input type="hidden" name="_csrf" value="TOKEN">');
		expect(html).toContain('<a href="/user/show/1">Ada</a>');
		expect(html).toContain('<a href="/user/show/2">Bob</a>');
		expect(html).toContain('<span class="badge">Administrator</span>');
		expect(html).toContain('<span class="badge">Member</span>');
		expect(html).toContain("<footer>© 2026</footer>");

		// Helpers actually invoked.
		expect(calls).toContain("t:greeting");
		expect(calls).toContain("t:footer");
		expect(calls).toContain("csrfField");
		expect(calls).toContain("asset:app.css");
		expect(calls).toContain("url:user.show");
		expect(calls).toContain("t:role.admin");
		expect(calls).toContain("t:role.user");
	});

	it("evaluates if comparator + helper in layout", async () => {
		write(
			root,
			"layouts/main.inker",
			"<html>{% if user.role === 'admin' %}<div>{{ t('role.admin') }}</div>{% else %}<div>{{ t('role.user') }}</div>{% endif %}{{> body }}</html>",
		);
		write(root, "index.inker", "{% layout 'layouts/main' %}body");
		const { helpers } = buildHelpers();
		const tpl = new Templates({ root, helpers });
		expect(await tpl.render("index", { user: { role: "admin" } })).toContain(
			"<div>Administrator</div>",
		);
		expect(await tpl.render("index", { user: { role: "user" } })).toContain(
			"<div>Member</div>",
		);
	});

	it("destructured each over Map + helper interpolation", async () => {
		write(
			root,
			"index.inker",
			"{% each prices as [k, v] %}{{ k }}={{ url('show', { id: v }) }} {% endeach %}",
		);
		const { helpers } = buildHelpers();
		const tpl = new Templates({ root, helpers });
		const html = await tpl.render("index", {
			prices: new Map([
				["A", 1],
				["B", 2],
			]),
		});
		expect(html).toBe("A=/show/1 B=/show/2 ");
	});

	it("component args support literal + helper expressions (lifts 53.3 D5)", async () => {
		write(
			root,
			"components/banner.inker",
			'<div class="{{ kind }}">{{ text }}</div>',
		);
		write(
			root,
			"index.inker",
			"{% component 'banner' { kind: 'warning', text: t('greeting') } %}",
		);
		const { helpers } = buildHelpers();
		const tpl = new Templates({ root, helpers });
		const html = await tpl.render("index", {});
		expect(html).toBe('<div class="warning">Hello</div>');
	});

	it("helper throws wrapped as E_INKER_HELPER_THROW with cause chain", async () => {
		const helpers = new Map<string, HelperFn>([
			[
				"boom",
				() => {
					throw new Error("kaboom");
				},
			],
		]);
		write(root, "index.inker", "{{ boom() }}");
		const tpl = new Templates({ root, helpers });
		await expect(tpl.render("index", {})).rejects.toThrow(
			/kaboom|HELPER_THROW/,
		);
	});
});
