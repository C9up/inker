/**
 * The prepend half of the stack store: `pushToTop` / `pushOnceToTop`. Both are
 * public on `Stacks` (exported from the barrel) and had no test at all, so
 * nothing pinned the one thing that distinguishes them from `pushTo` — that
 * their content lands BEFORE what was already there.
 */
import { describe, expect, it } from "vitest";
import { Stacks } from "../../src/stacks.js";

describe("inker > Stacks prepend", () => {
	it("puts pushToTop content before what was already pushed", () => {
		const stacks = new Stacks();
		const token = stacks.create("scripts");
		stacks.pushTo("scripts", "<b>");
		stacks.pushToTop("scripts", "<a>");

		// Prepend, not append: <a> was pushed second but comes out first.
		expect(stacks.fillPlaceholders(token)).toBe("<a><b>");
	});

	it("prepends onto a stack that does not exist yet", () => {
		const stacks = new Stacks();
		// A partial can push before the layout's @stack has been rendered.
		stacks.pushToTop("head", "<meta>");
		const token = stacks.create("head");

		expect(stacks.fillPlaceholders(token)).toBe("<meta>");
	});

	it("keeps prepend order across several pushToTop calls", () => {
		const stacks = new Stacks();
		const token = stacks.create("s");
		stacks.pushToTop("s", "1");
		stacks.pushToTop("s", "2");
		stacks.pushToTop("s", "3");

		// Each one goes in front of the previous.
		expect(stacks.fillPlaceholders(token)).toBe("321");
	});

	it("drops a second pushOnceToTop from the same source", () => {
		const stacks = new Stacks();
		const token = stacks.create("scripts");
		stacks.pushOnceToTop("scripts", "widget", "<script>");
		stacks.pushOnceToTop("scripts", "widget", "<script>");

		expect(stacks.fillPlaceholders(token)).toBe("<script>");
		expect(stacks.hasSource("scripts", "widget")).toBe(true);
	});

	it("lets a different source prepend to the same stack", () => {
		const stacks = new Stacks();
		const token = stacks.create("scripts");
		stacks.pushOnceToTop("scripts", "second", "B");
		stacks.pushOnceToTop("scripts", "first", "A");

		// Distinct sources both land, newest in front.
		expect(stacks.fillPlaceholders(token)).toBe("AB");
		expect(stacks.hasSource("scripts", "first")).toBe(true);
	});

	it("tracks once-sources per stack name, not globally", () => {
		const stacks = new Stacks();
		const head = stacks.create("head");
		const body = stacks.create("body");
		stacks.pushOnceToTop("head", "widget", "H");
		stacks.pushOnceToTop("body", "widget", "B");

		// Same source id, different stacks — the second must not be swallowed.
		expect(stacks.fillPlaceholders(`${head}|${body}`)).toBe("H|B");
	});
});
