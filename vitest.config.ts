import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// ream-provider.test.ts builds a real @c9up/ream + @c9up/rosetta app — a
		// monorepo-level integration test that can't run in the standalone repo.
		// The agnostic behaviour is covered by standalone-smoke.test.ts.
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"tests/integration/ream-provider.test.ts",
		],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			// Re-baselined for the Rust-migration src/ surface (Story 55.1):
			// the 7 lex/parse/render TS modules moved to Rust (105 cargo tests),
			// leaving Templates + provider + loadNapi. Integer floors of the
			// post-migration measurement per cerebrum feedback_no_filler_tests
			// (lock today's reality, not an aspirational target).
			thresholds: {
				statements: 88,
				functions: 96,
				branches: 78,
				lines: 89,
			},
		},
	},
});
