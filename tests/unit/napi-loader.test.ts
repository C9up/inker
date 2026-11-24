/**
 * Where inker's engine comes from: the local build first, the platform
 * package `@c9up/inker-<suffix>` second, and a coded refusal naming the one
 * to install when neither loads.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** Every function inker calls on its engine. */
const CALLS = ["parseTemplate", "astToJson", "openedPath"];

const standIn = (omit?: string) =>
	Object.fromEntries(
		CALLS.filter((name) => name !== omit).map((name) => [name, () => null]),
	);

/**
 * The host the loader is told it runs on, stubbed like the binary is, so the
 * suite asserts the same thing on every platform.
 */
const HOST = { platform: "linux", arch: "x64", suffix: "linux-x64-gnu" };

/** The platform package this host installs. */
const PLATFORM_PACKAGE = `@c9up/inker-${HOST.suffix}`;

/** What `require` throws for a module that is not there. */
function notFound(id: string): Error {
	return Object.assign(new Error(`Cannot find module '${id}'`), {
		code: "MODULE_NOT_FOUND",
	});
}

/** Load the loader with `require` running `load` for every module it asks for. */
async function withRequire(
	load: (id: string) => unknown,
	host: { platform: string; arch: string } = HOST,
) {
	vi.resetModules();
	vi.doMock("node:process", async (importOriginal) => ({
		...(await importOriginal<typeof import("node:process")>()),
		platform: host.platform,
		arch: host.arch,
	}));
	vi.doMock("node:module", async (importOriginal) => ({
		...(await importOriginal<typeof import("node:module")>()),
		createRequire: () => load,
	}));
	return {
		loader: await import("../../src/loadNapi.js"),
		errors: await import("../../src/errors.js"),
	};
}

/** What `getNative` throws, or `undefined` when it returns. */
function refusalOf(getNative: () => unknown): unknown {
	try {
		getNative();
		return undefined;
	} catch (error) {
		return error;
	}
}

afterEach(() => {
	vi.doUnmock("node:process");
	vi.doUnmock("node:module");
	vi.resetModules();
});

describe("inker > the engine comes from the local build or the platform package", () => {
	it("loads the platform package when no local binary is built", async () => {
		const asked: string[] = [];
		const { loader } = await withRequire((id) => {
			asked.push(id);
			if (id === PLATFORM_PACKAGE) return standIn();
			throw notFound(id);
		});

		expect(Object.keys(loader.getNative()).sort()).toEqual([...CALLS].sort());
		expect(asked).toHaveLength(2);
		expect(asked[0]).toMatch(/[\\/]index\.linux-x64-gnu\.node$/);
		expect(asked[1]).toBe(PLATFORM_PACKAGE);
	});

	it("prefers the local build, and never asks for the package then", async () => {
		const asked: string[] = [];
		const { loader } = await withRequire((id) => {
			asked.push(id);
			return standIn();
		});

		loader.getNative();

		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/index\.linux-x64-gnu\.node$/);
	});

	it("names the platform package to install when neither is there", async () => {
		const { loader, errors } = await withRequire((id) => {
			throw notFound(id);
		});

		const refusal = refusalOf(loader.getNative);

		expect(refusal).toBeInstanceOf(errors.E_INKER_NAPI_REQUIRED);
		expect(String(refusal)).toContain(
			`Fix: install ${PLATFORM_PACKAGE} at the exact version of @c9up/inker`,
		);
		expect(String(refusal)).toContain("pnpm build:napi");
		// The load error travels as the cause, not in the message.
		expect(refusal).toMatchObject({ cause: { code: "MODULE_NOT_FOUND" } });
		expect(String(refusal)).not.toContain("Cannot find module");
	});

	it("reports a local build that fails to load, instead of falling back to the package", async () => {
		const asked: string[] = [];
		const { loader } = await withRequire((id) => {
			asked.push(id);
			throw new Error("invalid ELF header");
		});

		const refusal = refusalOf(loader.getNative);

		expect(asked).toHaveLength(1);
		expect(String(refusal)).toContain(
			"Fix: index.linux-x64-gnu.node failed to load. Rebuild it: cd packages/inker && pnpm build:napi",
		);
		expect(String(refusal)).not.toContain("invalid ELF header");
		expect(refusal).toMatchObject({ cause: { message: "invalid ELF header" } });
	});

	it("refuses a platform package from another version", async () => {
		const { loader, errors } = await withRequire((id) => {
			if (id === PLATFORM_PACKAGE) return standIn("openedPath");
			throw notFound(id);
		});

		const refusal = refusalOf(loader.getNative);

		expect(refusal).toBeInstanceOf(errors.E_INKER_NAPI_REQUIRED);
		expect(String(refusal)).toContain(`Fix: install ${PLATFORM_PACKAGE}`);
		expect(String(Reflect.get(Object(refusal), "cause"))).toContain(
			`${PLATFORM_PACKAGE} loaded, but it lacks openedPath.`,
		);
	});

	it("lists the supported targets on a host no binary is built for", async () => {
		const asked: string[] = [];
		const { loader } = await withRequire(
			(id) => {
				asked.push(id);
				return standIn();
			},
			{ platform: "linux", arch: "riscv64" },
		);

		const refusal = refusalOf(loader.getNative);

		expect(asked).toHaveLength(0);
		expect(String(refusal)).toContain(
			"Fix: no prebuilt binary for linux-riscv64; inker ships one for linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.",
		);
		expect(refusal).not.toHaveProperty("cause");
	});
});
