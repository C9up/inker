/**
 * Inject a runtime-bad value into a typed slot for testing a runtime guard.
 *
 * THIS IS THE *ONE* PLACE IN @c9up/inker WHERE `as T` IS PERMITTED.
 * Everywhere else, see cerebrum DNR 2026-05-04 ("no `any` AND no `as` casts
 * in new code"). Encapsulating the bypass here keeps ad-hoc workarounds from
 * spreading across test files. Use ONLY when deliberately narrowing a
 * caught `unknown` exception to the concrete error subclass under test.
 *
 * Mirrors `packages/station/tests/__helpers__/bypass-type-check.ts`.
 */
export function bypassTypeCheck<T>(value: unknown): T {
	return value as T;
}

/** Convenience: narrow a caught `unknown` to a typed slot in tests. */
export function asTyped<T>(value: unknown): T {
	return bypassTypeCheck<T>(value);
}
