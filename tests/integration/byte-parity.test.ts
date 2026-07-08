/**
 * Story 55.1 byte-parity smoke gate (AC13 / T7.2).
 *
 * Renders a fixture covering every grammar production (interpolation + escape,
 * raw `{{{ ... }}}`, `@if/else/endif`, `@each(item in ...)` over Array,
 * `@each([k, v] in ...)` over Map, `@include()`, `@layout()` with
 * `{{> body }}`, `@component()` + 3 helper calls) against a fixed deterministic
 * data payload and asserts byte-equality against the expected output captured
 * once via `tests/__helpers__/capture-byte-parity.ts` BEFORE the Rust port.
 *
 * The expected output is committed INLINE in this file (base64-encoded, decoded
 * at runtime) per AC13 — base64 avoids editor / copy-paste whitespace stripping
 * since the rendered output legitimately contains trailing-spaces on indentation
 * lines around control tags.
 *
 * Re-capture procedure when intentionally changing the fixture or grammar:
 *   1. Update `tests/__helpers__/fixtures/byte-parity/*.inker` as needed.
 *   2. Run `pnpm tsx tests/__helpers__/capture-byte-parity.ts > /tmp/out.txt`
 *      from `packages/inker/`.
 *   3. Re-encode: `base64 -w 76 /tmp/out.txt` — replace the constant below.
 *   4. Re-run `pnpm test tests/integration/byte-parity.test.ts`.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HelperFn } from "../../src/helpers.js";
import { SafeString } from "../../src/SafeString.js";
import { Templates } from "../../src/Templates.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(
	here,
	"..",
	"__helpers__",
	"fixtures",
	"byte-parity",
);

// Base64 of the canonical rendered output. Originally captured 2026-05-29 against
// the pre-Rust-migration TS impl; RE-BASELINED 2026-07-08 (story 62.1) after the
// Edge-syntax migration — the fixture moved to `@`-tags and the new
// newline-trim-after-tag feature removed the blank lines that followed each tag.
// The diff was verified content-identical (only tag-adjacent whitespace changed).
// Re-capture via `tests/__helpers__/capture-byte-parity.ts` (see procedure above).
const BYTE_PARITY_EXPECTED_B64 = [
	"PCFkb2N0eXBlIGh0bWw+CjxodG1sPjxib2R5Pgo8aGVhZGVyPldlbGNvbWUgJmx0O2JvbGQmZ3Q7",
	"PC9oZWFkZXI+CjxzZWN0aW9uPgogIDxoMj5DYXJ0ICZsdDtJdGVtcyZndDs8L2gyPgogICAgPHVs",
	"PgogICAgICAgIDxsaT5BUFBMRSDigJQgMS4yMDwvbGk+CiAgICAgICAgPGxpPlBFQVIg4oCUIDAu",
	"ODA8L2xpPgogICAgICA8L3VsPgogIAogICAgPHA+YSA9IDE8L3A+CiAgICA8cD5iID0gMjwvcD4K",
	"ICAKICA8cD48ZW0+bm90IGVzY2FwZWQ8L2VtPjwvcD4KICA8cD4mbHQ7Ym9sZCZndDs8L3A+CiAg",
	"PHA+VDpoZWxsby53b3JsZDwvcD4KICA8cD4vdS91c2Vycy5zaG93LzQyPC9wPgoKICA8YnV0dG9u",
	"IGRhdGEtbGFiZWw9IkNhcnQgJmx0O0l0ZW1zJmd0OyI+Q2FydCAmbHQ7SXRlbXMmZ3Q7IChhY3Rp",
	"dmU9dHJ1ZSk8L2J1dHRvbj4KPC9zZWN0aW9uPgo8Zm9vdGVyPsKpIDIwMjY8L2Zvb3Rlcj4KCjwv",
	"Ym9keT48L2h0bWw+Cg==",
].join("");

const BYTE_PARITY_EXPECTED = Buffer.from(
	BYTE_PARITY_EXPECTED_B64,
	"base64",
).toString("utf8");

describe("byte-parity smoke gate (55.1 AC13)", () => {
	it("renders the fixture byte-for-byte against the captured expected output", async () => {
		const helpers = new Map<string, HelperFn>([
			[
				"upper",
				(...args: readonly unknown[]): string => String(args[0]).toUpperCase(),
			],
			[
				"t",
				(...args: readonly unknown[]): SafeString =>
					new SafeString(`T:${String(args[0])}`),
			],
			[
				"url",
				(...args: readonly unknown[]): string => {
					const name = String(args[0]);
					const second = args[1];
					const id =
						second !== null && typeof second === "object" && "id" in second
							? Reflect.get(second, "id")
							: "";
					return `/u/${name}/${String(id)}`;
				},
			],
		]);

		const data = {
			title: "Cart <Items>",
			showItems: true,
			active: true,
			userId: 42,
			greeting: "<bold>",
			rawHtml: "<em>not escaped</em>",
			year: 2026,
			items: [
				{ name: "Apple", price: "1.20" },
				{ name: "Pear", price: "0.80" },
			],
			mappings: new Map<string, string>([
				["a", "1"],
				["b", "2"],
			]),
		};

		const templates = new Templates({
			root: fixturesRoot,
			cacheMode: "never",
			helpers,
		});
		const output = await templates.render("byte-parity", data);

		expect(output).toBe(BYTE_PARITY_EXPECTED);
	});
});
