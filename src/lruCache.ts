/**
 * A Map bounded to `capacity` entries that drops the least recently used one
 * when full. `Map` keeps insertion order, so a hit is moved to the end and the
 * first key is always the oldest.
 */
export class LruCache<K, V> {
	readonly #entries = new Map<K, V>();
	readonly #capacity: number;

	constructor(capacity: number) {
		this.#capacity = capacity;
	}

	get size(): number {
		return this.#entries.size;
	}

	get(key: K): V | undefined {
		const value = this.#entries.get(key);
		if (value !== undefined) {
			this.#entries.delete(key);
			this.#entries.set(key, value);
		}
		return value;
	}

	set(key: K, value: V): void {
		this.#entries.delete(key);
		this.#entries.set(key, value);
		if (this.#entries.size > this.#capacity) {
			const oldest = this.#entries.keys().next();
			if (!oldest.done) this.#entries.delete(oldest.value);
		}
	}

	clear(): void {
		this.#entries.clear();
	}
}
