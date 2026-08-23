import { randomUUID } from "node:crypto";

/**
 * Named output stacks — the store behind `@stack`, `@pushTo` and `@pushOnceTo`
 * (Edge parity). `@stack('scripts')` writes an opaque placeholder into the
 * output and registers the name; every `@pushTo('scripts')` appends its rendered
 * body to that name's bucket. Once the whole template (body, sections and
 * layout) has rendered, `fillPlaceholders` swaps each placeholder for its
 * bucket's contents.
 *
 * Pushing before the stack exists is legitimate and common: a partial rendered
 * early pushes a `<script>` that the layout's `@stack` — rendered last — picks
 * up. That is why filling is a final pass and not an inline substitution.
 */
/** Join a stack name and a source id into one set key. Every producer must
 * use this: `hasSource` and `pushOnceTo` once joined differently, so the
 * lookup never matched and a repeat body was rendered before being dropped.
 */
function sourceKey(name: string, sourceId: string): string {
	return `${name}\u0000${sourceId}`;
}

export class Stacks {
	/** Accumulated content per stack name, in push order. */
	readonly #contents: Map<string, string[]> = new Map();
	/** Placeholder token per created stack name. */
	readonly #placeholders: Map<string, string> = new Map();
	/** `name` + `sourceId` pairs already pushed, for the `once` variants. */
	readonly #sources: Set<string> = new Set();
	/**
	 * Per-instance random prefix. Placeholders are substituted by value in the
	 * final HTML, so a guessable token would let a rendered data value forge one
	 * and capture a stack's contents. A UUID per render makes that unforgeable.
	 */
	readonly #salt: string = randomUUID();

	#bucket(name: string): string[] {
		let bucket = this.#contents.get(name);
		if (bucket === undefined) {
			bucket = [];
			this.#contents.set(name, bucket);
		}
		return bucket;
	}

	/**
	 * Create a stack placeholder and return the token to emit. Two `@stack` tags
	 * with the same name are an authoring mistake — the second would silently
	 * never be filled — so it throws rather than degrading.
	 */
	create(name: string): string {
		if (this.#placeholders.has(name)) {
			throw new Error(
				`@stack('${name}') is declared twice — a stack can only be output once per render`,
			);
		}
		const token = `<!--inker-stack:${this.#salt}:${name}-->`;
		this.#placeholders.set(name, token);
		return token;
	}

	/** Append content to a stack. The stack need not exist yet. */
	pushTo(name: string, contents: string): this {
		this.#bucket(name).push(contents);
		return this;
	}

	/** Prepend content to a stack. */
	pushToTop(name: string, contents: string): this {
		this.#bucket(name).unshift(contents);
		return this;
	}

	/**
	 * Whether `sourceId` has already pushed to `name`. Lets a caller skip
	 * RENDERING a `@pushOnceTo` body it would only discard.
	 */
	hasSource(name: string, sourceId: string): boolean {
		return this.#sources.has(sourceKey(name, sourceId));
	}

	/** Append content once per source; later pushes from the same site are dropped. */
	pushOnceTo(name: string, sourceId: string, contents: string): this {
		const key = sourceKey(name, sourceId);
		if (this.#sources.has(key)) return this;
		this.#sources.add(key);
		return this.pushTo(name, contents);
	}

	/** Prepend content once per source. */
	pushOnceToTop(name: string, sourceId: string, contents: string): this {
		const key = sourceKey(name, sourceId);
		if (this.#sources.has(key)) return this;
		this.#sources.add(key);
		return this.pushToTop(name, contents);
	}

	/** Replace every placeholder in `contents` with its stack's content. */
	fillPlaceholders(contents: string): string {
		let out = contents;
		for (const [name, token] of this.#placeholders) {
			out = out.split(token).join((this.#contents.get(name) ?? []).join(""));
		}
		return out;
	}
}
