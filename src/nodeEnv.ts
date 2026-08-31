/**
 * Reading `NODE_ENV`, with the aliases people actually set.
 *
 * `NODE_ENV=prod` is ordinary in a Dockerfile or a platform dashboard. Read
 * verbatim it answers "not production", and the `auto` cache mode then stats
 * every template on every render in production — and re-reads one an operator
 * edited in place, which is the behaviour `never` exists to prevent.
 *
 * Duplicated rather than imported: inker is a leaf package with no runtime
 * dependencies, and that is the property the standalone test proves.
 */

const DEV_ENVS = ["dev", "develop", "development"];
const PROD_ENVS = ["prod", "production"];
const TEST_ENVS = ["test", "testing"];

/** The canonical name for whatever `NODE_ENV` holds. */
export function normalizeNodeEnv(value: string | undefined): string {
	if (!value || typeof value !== "string") return "unknown";
	const env = value.toLowerCase();
	if (DEV_ENVS.includes(env)) return "development";
	if (PROD_ENVS.includes(env)) return "production";
	if (TEST_ENVS.includes(env)) return "test";
	return env;
}

/** Whether this process is running in production, under any spelling. */
export function inProduction(): boolean {
	return normalizeNodeEnv(process.env.NODE_ENV) === "production";
}
