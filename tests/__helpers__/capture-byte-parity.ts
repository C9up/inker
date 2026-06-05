/**
 * One-shot capture script for the Story 55.1 byte-parity smoke gate.
 *
 * Renders the fixture at `tests/__helpers__/fixtures/byte-parity/byte-parity.inker`
 * against the CURRENT (pre-Rust-migration) `Templates` impl and prints the exact
 * rendered output to stdout.
 *
 * The output is then pasted verbatim into the `BYTE_PARITY_EXPECTED` constant
 * inside `tests/integration/byte-parity.test.ts` (T7.2) and becomes the
 * ground-truth assertion target the Rust port must reproduce byte-for-byte.
 *
 * Re-run with: `pnpm tsx tests/__helpers__/capture-byte-parity.ts` from
 * `packages/inker/`.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { HelperFn } from "../../src/helpers.js";
import { SafeString } from "../../src/SafeString.js";
import { Templates } from "../../src/Templates.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "fixtures", "byte-parity");

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

const templates = new Templates({ root, cacheMode: "never", helpers });
const output = await templates.render("byte-parity", data);

process.stdout.write(output);
