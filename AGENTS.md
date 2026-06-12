# AGENTS.md

Guidance for AI agents using and maintaining `caesar-search` (TypeScript).

## Using the SDK

- The loop: `search()` → pick `doc_id` → `read()` → optionally `feedback()`. Thread provenance handles (`doc_id`, `search_id`) between calls.
- `read()` accepts a doc_id or URL positionally. A truncated read sets `content.truncated`; continue with `startChar: content.start_char + content.char_count` — do not retry with a bigger `maxChars`.
- `search(query, { verbosity })` controls payload shape: `ids_only` (handles only), `compact`, `standard` (default), `full` (adds provenance). `maxCharsTotal` sets a hard response budget.
- Set `CAESAR_API_KEY`; never hardcode keys. Catch `AuthenticationError`/`RateLimitError`/`APIStatusError`.
- For Vercel AI SDK agents, import `caesarTools()` from `caesar-search/ai`.

## Common mistakes

| Mistake | Correction |
|---|---|
| `caesar.search(query, { limit: 5 })` | The option is `maxResults` |
| `caesar.document(...)` / `caesar.getDocument(...)` | The method is `read()` |
| Retrying truncated reads with bigger `maxChars` | Use `startChar` continuation |
| Expecting camelCase response fields | Response models are snake_case, matching the API |
| Hand-editing `src/generated/` | Generated from `spec/openapi-public.json`; run `bun run generate` instead |

## Maintaining this repo

- Bun-first: `bun install`, `bun test`, `bun run build` (tsup, ESM+CJS+dts), `bun run lint` (Biome), `bun run typecheck`.
- `spec/openapi-public.json` is the vendored contract; `bun run generate` (@hey-api/openapi-ts) regenerates `src/generated/`. CI fails if the generated code is dirty against the spec.
- The spec-sync workflow polls the live public spec, regenerates, classifies the diff with oasdiff, and auto-releases non-breaking changes; breaking changes open a PR for review.
- `src/generated/` is excluded from Biome; never edit it by hand.
- Releases bump both `package.json` and the `VERSION` constant in `src/index.ts`.
- Tests are hermetic (`Bun.serve` mock server); no network access required.
- Never name upstream search/inference providers in code, docs, or errors.
