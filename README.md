# @c9up/inker

Server-side templating module for the Ream framework. Loads `.inker` files from disk, parses them with a hand-rolled lexer + AST, and renders against a plain data object. HTML-escape by default; raw output via the explicit triple-brace form. Strict-by-default: unknown identifiers throw rather than render blank.

## File convention

Templates live as `<root>/<name>.inker` files. Resolve the root yourself (absolute path) and pass it once at construction:

```ts
import { Templates } from "@c9up/inker";

const templates = new Templates({ root: "/abs/path/to/templates" });
const html = await templates.render("invoice", { customer: { name: "Alice" }, total: 42 });
```

Interpolation is `{{ expr }}` (HTML-escaped) or `{{{ expr }}}` (raw). The `expr` between the braces is a full JavaScript expression — member access, arithmetic, calls, ternaries, template literals, arrow functions — evaluated in V8 with the registered helpers and globals in scope. That reach is why a template is code, never user input: see [Templates are code, not input](#templates-are-code-not-input).

## Strict by default

- Missing templates throw `errors.E_INKER_TEMPLATE_NOT_FOUND`.
- A name missing from the render data reads as `undefined` (guard it with `@if(name)`); navigating into it throws an `InkerError` with `code: "E_INKER_UNKNOWN_IDENTIFIER"`, and the `filename`, `line` and `col` of the offending expression.
- Parse errors throw an `InkerError` with the code of what is wrong (`E_INKER_UNCLOSED_BLOCK`, `E_INKER_PARSE_ERROR`…) and its position.

The full reference (file layout, cache semantics, error surface) lives at <https://reamjs.com/en/guides/frontend/templates/>.

## Testing

```sh
pnpm --filter @c9up/inker test            # full suite
pnpm --filter @c9up/inker test:coverage   # enforces v8 coverage gate
```

The coverage gate (v8 provider) is wired in `vitest.config.ts` with thresholds at `statements: 88 / functions: 96 / branches: 78 / lines: 89` (re-baselined for the Rust-migration src/ surface — the lex/parse/render modules moved to Rust, covered by 105 `cargo test` cases). A regression that drops below any of those floors fails CI.

## Native binary

The lexer and parser run in Rust via napi-rs; rendering, expressions included, runs in V8. The TypeScript surface (`Templates`, `InkerProvider`, `SafeString`, `errors`) is unchanged — the engine is loaded transparently from a prebuilt `.node` binary.

Each platform's engine is its own npm package, which `@c9up/inker` lists as an optional dependency at its exact version:

| Platform | Package |
|---|---|
| Linux x64 (glibc) | `@c9up/inker-linux-x64-gnu` |
| Linux arm64 (glibc) | `@c9up/inker-linux-arm64-gnu` |
| macOS x64 | `@c9up/inker-darwin-x64` |
| macOS arm64 | `@c9up/inker-darwin-arm64` |
| Windows x64 | `@c9up/inker-win32-x64-msvc` |

Your package manager installs only the one that matches the machine (`os`, `cpu` and `libc` fields), so an install downloads one binary and needs no Rust toolchain. An install run with optional dependencies omitted (`--no-optional`, `--omit=optional`) skips it.

- **No JS fallback.** If the engine is missing or fails to load, every render throws `E_INKER_NAPI_REQUIRED`. Its message names the package to install (for example `Fix: install @c9up/inker-linux-x64-gnu at the exact version of @c9up/inker: ...`); the load error itself is the exception's `cause`.
- **Build locally:** in a checkout of this repository, `pnpm --filter @c9up/inker build:napi` compiles the `inker-engine-napi` crate (release) and copies `index.<platform>.node` into the package root. inker loads that file before looking for the platform package. `node scripts/platform-packages.mjs` rewrites the platform packages' manifests (`npm/<platform>/package.json`) and the optional dependencies after a version bump; CI fails when they are stale.
- **Helpers are plain TS functions in V8 scope.** Custom helpers registered via `TemplatesOptions.helpers` (or `InkerProvider`) — and the core globals — are in lexical scope when the Node renderer evaluates each expression in V8 (plain functions in lexical scope; no Rust knowledge required to write one). They can be called **anywhere** an expression can: whole interpolations (`{{ helper(args) }}`), `@if()` conditions, `@each()` iterables, operator expressions, and nested-call / loop-scoped arguments (`{{ users.filter(u => can(u)) }}`). Arguments are the real JS values — a `Date` stays a `Date`, a `Map` a `Map`, `bigint`/`NaN`/`±Infinity` untouched — there is no NAPI/JSON coercion. A helper returning a `SafeString` is emitted raw.

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

