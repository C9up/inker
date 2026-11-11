/**
 * Placeholders are substituted by value in the final HTML, so a rendered data
 * value shaped like one could capture a stack's contents. The guard is a token
 * that no value can know: a fresh random one per render.
 */
import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { Stacks } from "../../src/stacks.js";
import { Templates } from "../../src/Templates.js";

const PAGE =
	"@pushTo('scripts')<script>SECRET</script>@endpushTo[{{{ fake }}}]@stack('scripts')";

describe("inker > stack placeholder forgery", () => {
	it("gives every render its own placeholder token", () => {
		const first = new Stacks().create("scripts");
		const second = new Stacks().create("scripts");
		expect(first).toMatch(/^<!--inker-stack:[0-9a-f-]{36}:scripts-->$/);
		expect(second).not.toBe(first);
	});

	it("leaves a value shaped like a placeholder unfilled", () => {
		const templates = new Templates({ root: os.tmpdir() });
		const guessed =
			"<!--inker-stack:00000000-0000-0000-0000-000000000000:scripts-->";
		// A token another render really used, leaked somehow, is no better.
		const leaked = new Stacks().create("scripts");
		for (const fake of [guessed, leaked, "<!--inker-stack:scripts-->"]) {
			const out = templates.renderString(PAGE, { fake });
			expect(out).toBe(`[${fake}]<script>SECRET</script>`);
		}
	});
});
