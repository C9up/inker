import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Templates } from "../../src/Templates.js";

// An in-memory template answers the full name it was registered under, disk
// prefix included — never the same bare name on another disk.

function dirWith(files: Record<string, string>): string {
	const dir = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "inker-mem-")),
	);
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(dir, `${name}.inker`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, source);
	}
	return dir;
}

function engine(): Templates {
	const t = new Templates({ root: dirWith({}), cacheMode: "never" });
	t.mount(
		"admin",
		dirWith({
			welcome: "FROM ADMIN DISK",
			"components/button": "ADMIN BUTTON",
		}),
	);
	return t;
}

describe("in-memory templates and disks", () => {
	it("does not let a default-disk template answer admin::welcome", async () => {
		const t = engine();
		t.registerTemplate("welcome", { template: "FROM MEMORY" });
		expect(await t.render("admin::welcome")).toBe("FROM ADMIN DISK");
		expect(await t.render("welcome")).toBe("FROM MEMORY");
		expect(t.resolve("admin::welcome")).toEqual({
			template: "FROM ADMIN DISK",
		});
	});

	it("answers only the disk-prefixed name it was registered under", async () => {
		const t = engine();
		t.registerTemplate("admin::welcome", { template: "ADMIN MEMORY" });
		expect(await t.render("admin::welcome")).toBe("ADMIN MEMORY");
		expect(t.renderSync("admin::welcome")).toBe("ADMIN MEMORY");
		await expect(t.render("welcome")).rejects.toThrow(/Template not found/);
		expect(t.templates).toEqual({
			"admin::welcome": { template: "ADMIN MEMORY" },
		});
		t.removeTemplate("admin::welcome");
		expect(await t.render("admin::welcome")).toBe("FROM ADMIN DISK");
	});

	it("keeps an in-memory component on its own disk", async () => {
		const t = engine();
		t.registerTemplate("components/button", { template: "MEMORY BUTTON" });
		t.registerTemplate("page", {
			template: "@!component('button')|@!component('admin::button')",
		});
		expect(await t.render("page")).toBe("MEMORY BUTTON|ADMIN BUTTON");
	});
});
