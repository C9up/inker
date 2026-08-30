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
- **Helpers are plain TS functions in V8 scope.** Custom helpers registered via `TemplatesOptions.helpers` (or `InkerProvider`) — and the core globals — are in lexical scope when the Node renderer evaluates each expression in V8 (the Edge model; no Rust knowledge required to write one). They can be called **anywhere** an expression can: whole interpolations (`{{ helper(args) }}`), `@if()` conditions, `@each()` iterables, operator expressions, and nested-call / loop-scoped arguments (`{{ users.filter(u => can(u)) }}`). Arguments are the real JS values — a `Date` stays a `Date`, a `Map` a `Map`, `bigint`/`NaN`/`±Infinity` untouched — there is no NAPI/JSON coercion. A helper returning a `SafeString` is emitted raw.

## Templates are code, not input

A template is a **trusted source file**, on the same footing as the TypeScript
around it. It is not a sandbox, and it is not meant to be one.

Expressions are evaluated as JavaScript, in scope with the helpers and globals
the app registered. That is what lets `{{ users.filter(u => can(u)) }}` work at
all — and it is also why a template can reach anything JavaScript can reach.
The usual escapes (`{}.constructor`, and everything they lead to) are not
blocked, because blocking them would not make the rest safe.

**Never render a template whose text came from a user.** Not from a form, not
from a database row someone can edit, not from a file an upload can replace.
Rendering user-supplied template TEXT is remote code execution, exactly as
`eval` would be.

User-supplied **data** is a different thing entirely, and it is safe: values
interpolated into a template are HTML-escaped by default (`{{ value }}`), and
only `{{{ value }}}` or a `SafeString` opts out.

## Standalone use

`@c9up/inker` is a leaf package — it has zero runtime dependencies and works in any Node.js app without `@c9up/ream` or `@c9up/rosetta` installed. The `tests/integration/standalone-smoke.test.ts` test proves this by packing the workspace tarball, installing it into a synthetic consumer (no ream, no rosetta), and rendering a composite template.

The `@c9up/inker/provider` sub-path (the `InkerProvider` class) is importable without those peers as well — its `InkerAppContext` is duck-typed, so structural import never reaches the ream runtime. Wiring the provider into a real container still requires a Ream host at boot time.

