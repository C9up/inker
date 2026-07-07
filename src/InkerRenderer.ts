import type { AsyncLocalStorage } from "node:async_hooks";
import type { Templates } from "./Templates.js";

/**
 * Duck-typed contract for the per-request context Inker reads inside its
 * canonical helper bodies. Keeping the interface local (instead of importing
 * `@c9up/ream`'s HttpContext) preserves Inker's leaf-invariant: the
 * InkerRenderer file lives in the LEAF half of the package and must compile
 * without `@c9up/ream` installed. Ream's HttpContext structurally satisfies
 * this shape — verified by the integration test's compile step.
 */
export interface InkerHttpContext {
	readonly request: object;
	readonly response: {
		type(value: string): unknown;
		send(body: string): unknown;
	};
	readonly store: Map<string, unknown>;
	readonly locale: string;
}

export class InkerRenderer {
	readonly #templates: Templates;
	readonly #als: AsyncLocalStorage<InkerHttpContext>;

	constructor(templates: Templates, als: AsyncLocalStorage<InkerHttpContext>) {
		this.#templates = templates;
		this.#als = als;
	}

	async render(
		ctx: InkerHttpContext,
		name: string,
		data: Readonly<Record<string, unknown>>,
	): Promise<void> {
		const html = await this.#als.run(ctx, () =>
			this.#templates.render(name, data),
		);
		ctx.response.type("text/html; charset=utf-8");
		ctx.response.send(html);
	}

	async renderToString(
		ctx: InkerHttpContext,
		name: string,
		data: Readonly<Record<string, unknown>>,
	): Promise<string> {
		return this.#als.run(ctx, () => this.#templates.render(name, data));
	}

	/**
	 * Mount a named templates disk on the shared engine (AdonisJS/Edge
	 * `edge.mount(name, dir)` parity). A package that ships its own templates
	 * mounts its directory under a namespace, then renders `name::template`.
	 * Delegates to the underlying `Templates` engine.
	 */
	mount(diskName: string, dir: string): void {
		this.#templates.mount(diskName, dir);
	}

	/** Unmount a named disk (`edge.unmount(name)` parity). Delegates to Templates. */
	unmount(diskName: string): void {
		this.#templates.unmount(diskName);
	}

	/** @internal Test seam — access the underlying Templates for cache control. */
	get _templates(): Templates {
		return this.#templates;
	}
}
