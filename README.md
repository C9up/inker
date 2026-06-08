# @c9up/inker

Server-side templating module for the Ream framework. Loads `.inker` files from disk, parses them with a hand-rolled lexer + AST, and renders against a plain data object. HTML-escape by default; raw output via the explicit triple-brace form. Strict-by-default: unknown identifiers throw rather than render blank.

## File convention

Templates live as `<root>/<name>.inker` files. Resolve the root yourself (absolute path) and pass it once at construction:

```ts
import { Templates } from "@c9up/inker";

const templates = new Templates({ root: "/abs/path/to/templates" });
const html = await templates.render("invoice", { customer: { name: "Alice" }, total: 42 });
```

Interpolation is `{{ expr }}` (HTML-escaped) or `{{{ expr }}}` (raw). The `expr` is a member-access path (`customer.name`, `items[0].title`, `items["weird key"]`); arithmetic, calls, ternaries, and template literals go through registered helpers.

## Strict by default

- Missing templates throw `InkerRenderError` with `code: "E_INKER_TEMPLATE_NOT_FOUND"`.
- Unknown identifiers throw `code: "E_INKER_UNKNOWN_IDENTIFIER"` with the consumed path and the line + column of the offending interpolation.
- Parse errors throw `code: "E_INKER_PARSE_ERROR"` with a precise reason.

The full reference (file layout, cache semantics, error surface) lives at <https://ream.dev/modules/inker>.

## Testing

```sh
pnpm --filter @c9up/inker test            # full suite
pnpm --filter @c9up/inker test:coverage   # enforces v8 coverage gate
```

The coverage gate (v8 provider) is wired in `vitest.config.ts` with thresholds at `statements: 88 / functions: 96 / branches: 78 / lines: 89` (re-baselined for the Rust-migration src/ surface — the lex/parse/render modules moved to Rust, covered by 105 `cargo test` cases). A regression that drops below any of those floors fails CI.

## Native binary

The lex / parse / render hot path runs in Rust via napi-rs (Story 55.1). The TypeScript surface (`Templates`, `InkerProvider`, `SafeString`, `InkerRenderError`) is unchanged — the engine is loaded transparently from a prebuilt `.node` binary.

- **Build locally:** `pnpm --filter @c9up/inker build:napi` compiles the `inker-engine-napi` crate (release) and copies `index.<platform>.node` into the package root. The 5-platform NAPI CI matrix (`linux-x64-gnu`, `linux-arm64-gnu`, `darwin-x64`, `darwin-arm64`, `win32-x64-msvc`) builds these on native runners.
- **No JS fallback.** If the binary is missing or fails to load, every render throws `E_INKER_NAPI_REQUIRED` with an actionable hint pointing at `pnpm --filter @c9up/inker build:napi`. Run that after a fresh checkout or a platform change.
- **Helpers stay in TypeScript.** Custom helpers registered via `TemplatesOptions.helpers` (or `InkerProvider`) are plain TS functions. The renderer resolves them TS-side before the native render pass (collect → invoke → render — no V8 callback), so no Rust knowledge is required to write one. Helpers must appear as a whole interpolation (`{{ helper(args) }}`) or a component-arg value; they are not supported inside `{% if %}` conditions, `{% each %}` iterables, operator expressions, or as nested-call arguments. Helper **arguments** are evaluated in the Rust engine and cross the NAPI boundary as JSON, so they are JSON-coerced before the helper runs: a `Date` arrives as a string, a `bigint` as a (possibly lossy) number, and `NaN`/`±Infinity` as `null`. Pass pre-stringified values for any type that does not survive JSON.

## Standalone use

`@c9up/inker` is a leaf package — it has zero runtime dependencies and works in any Node.js app without `@c9up/ream` or `@c9up/rosetta` installed. The `tests/integration/standalone-smoke.test.ts` test proves this by packing the workspace tarball, installing it into a synthetic consumer (no ream, no rosetta), and rendering a composite template.

The `@c9up/inker/provider` sub-path (the `InkerProvider` class) is importable without those peers as well — its `InkerAppContext` is duck-typed, so structural import never reaches the ream runtime. Wiring the provider into a real container still requires a Ream host at boot time.

