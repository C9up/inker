/** Minimal stand-in for the host's Macroable base — the shape inker's provider
 * duck-types when it installs `ctx.view`. */
export class Macroable {
	static getter(name: string, fn: () => unknown, singleton = false): void {
		if (!singleton) {
			Object.defineProperty(Macroable.prototype, name, {
				get: fn,
				configurable: true,
			});
			return;
		}
		const cacheKey = Symbol(name);
		Object.defineProperty(Macroable.prototype, name, {
			configurable: true,
			get(this: Record<symbol, unknown>) {
				if (!(cacheKey in this)) {
					Object.defineProperty(this, cacheKey, {
						value: fn.call(this),
						configurable: true,
					});
				}
				return this[cacheKey];
			},
		});
	}
}
