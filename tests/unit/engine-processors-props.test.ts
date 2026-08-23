/**
 * Edge parity: conditional prop merges and the source/output processor stages.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "inker-proc-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function write(name: string, contents: string): void {
	const file = path.join(root, `${name}.inker`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents);
}

describe("inker > $props.mergeIf / mergeUnless", () => {
	it("mergeIf applies the defaults only when the condition is truthy", async () => {
		write(
			"page",
			"@component('field', { withClass: true })|@component('field', { withClass: false })",
		);
		write(
			"components/field",
			"[{{ $props.mergeIf($props.get('withClass'), { class: 'input' }).except(['withClass']).toAttrs() }}]",
		);
		const t = new Templates({ root, cacheMode: "never" });
		expect(await t.render("page")).toBe('[class="input"]|[]');
	});

	it("mergeUnless applies the defaults only when the condition is falsy", async () => {
		write(
			"page",
			"@component('field', { bare: true })|@component('field', { bare: false })",
		);
		write(
			"components/field",
			"[{{ $props.mergeUnless($props.get('bare'), { class: 'input' }).except(['bare']).toAttrs() }}]",
		);
		const t = new Templates({ root, cacheMode: "never" });
		expect(await t.render("page")).toBe('[]|[class="input"]');
	});
});

describe("inker > processor", () => {
	it("runs a raw processor over a file's source before parsing", async () => {
		write("page", "hello NAME");
		const t = new Templates({ root, cacheMode: "never" });
		t.processor.process("raw", ({ raw }) => raw.replace("NAME", "{{ who }}"));
		expect(await t.render("page", { who: "world" })).toBe("hello world");
	});

	it("runs a raw processor over an inline source too", () => {
		const t = new Templates({ root, cacheMode: "never" });
		t.processor.process("raw", ({ raw }) => raw.toUpperCase());
		expect(t.renderString("abc")).toBe("ABC");
	});

	it("runs an output processor over rendered HTML", async () => {
		write("page", "<p>{{ x }}</p>");
		const t = new Templates({ root, cacheMode: "never" });
		t.processor.process("output", ({ output }) => `<!--wrapped-->${output}`);
		expect(await t.render("page", { x: "1" })).toBe("<!--wrapped--><p>1</p>");
	});

	it("leaves the value untouched when a processor returns undefined", () => {
		const t = new Templates({ root, cacheMode: "never" });
		t.processor.process("output", () => undefined);
		expect(t.renderString("kept")).toBe("kept");
	});

	it("chains processors in registration order", () => {
		const t = new Templates({ root, cacheMode: "never" });
		t.processor.process("output", ({ output }) => `${output}-a`);
		t.processor.process("output", ({ output }) => `${output}-b`);
		expect(t.renderString("x")).toBe("x-a-b");
	});

	it("rejects Edge's 'compiled' stage, which has no equivalent here", () => {
		const t = new Templates({ root, cacheMode: "never" });
		// Parsed, not cast: `compiled` is unreachable through the typed
		// overloads, so the point is what an untyped caller can hand over.
		const compiled = JSON.parse('"compiled"');
		expect(() => t.processor.process(compiled, () => undefined)).toThrow(
			/no equivalent/,
		);
	});

	it("rejects a non-function handler", () => {
		const t = new Templates({ root, cacheMode: "never" });
		expect(() =>
			(t.processor.process as (s: string, f: unknown) => void)("raw", 1),
		).toThrow(/must be a function/);
	});
});

describe("inker > Edge-shaped render aliases", () => {
	it("renderRawSync mirrors renderString", () => {
		const t = new Templates({ root, cacheMode: "never" });
		expect(t.renderRawSync("{{ 1 + 1 }}")).toBe("2");
	});

	it("renderRaw resolves the same output", async () => {
		const t = new Templates({ root, cacheMode: "never" });
		await expect(t.renderRaw("{{ name }}", { name: "x" })).resolves.toBe("x");
	});
});

describe("inker > registerTemplate", () => {
	it("renders a template registered from memory", async () => {
		const t = new Templates({ root, cacheMode: "never" });
		t.registerTemplate("greeting", { template: "hello {{ who }}" });
		expect(await t.render("greeting", { who: "world" })).toBe("hello world");
	});

	it("is reachable as a partial from a file on disk", async () => {
		write("page", "[@include('snippet')]");
		const t = new Templates({ root, cacheMode: "never" });
		t.registerTemplate("snippet", { template: "in-memory" });
		expect(await t.render("page")).toBe("[in-memory]");
	});

	it("is reachable as a component under its components/ name", async () => {
		write("page", "@component('card', { title: 'T' })");
		const t = new Templates({ root, cacheMode: "never" });
		t.registerTemplate("components/card", { template: "[{{ title }}]" });
		expect(await t.render("page")).toBe("[T]");
	});

	it("takes precedence over a file of the same name", async () => {
		write("page", "from disk");
		const t = new Templates({ root, cacheMode: "never" });
		t.registerTemplate("page", { template: "from memory" });
		expect(await t.render("page")).toBe("from memory");
	});

	it("removeTemplate hands the name back to the disk", async () => {
		write("page", "from disk");
		const t = new Templates({ root, cacheMode: "never" });
		t.registerTemplate("page", { template: "from memory" });
		t.removeTemplate("page");
		expect(await t.render("page")).toBe("from disk");
	});

	it("rejects a missing template body", () => {
		const t = new Templates({ root, cacheMode: "never" });
		expect(() =>
			(t.registerTemplate as (n: string, c: unknown) => void)("x", {}),
		).toThrow(/must be a string/);
	});
});

describe("inker > $caller", () => {
	it("tells a component where it was invoked from", async () => {
		write("page", "@component('probe', {})");
		write(
			"components/probe",
			"[{{ $caller.filename }}:{{ $caller.line }}:{{ $caller.col }}]",
		);
		const t = new Templates({ root, cacheMode: "never" });
		expect(await t.render("page")).toBe("[page:1:1]");
	});
});
