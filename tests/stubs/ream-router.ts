/**
 * Local stand-in for `@c9up/ream/services/router`, aliased in vitest.config so
 * InkerProvider.start()'s dynamic `import("@c9up/ream/services/router")` resolves
 * standalone — without the optional `@c9up/ream` peer. Mirrors the slice the
 * provider touches: a `default` router exposing `makeUrl`.
 */
const router = {
	makeUrl(name: string, params?: Record<string, string>): string {
		return params
			? `/${name}/${Object.values(params).join("/")}`
			: `/${name}`;
	},
};

export default router;
