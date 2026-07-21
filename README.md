# caesar-search

Official TypeScript SDK for the [Caesar](https://github.com/caesar-data) search API — web search with provenance, built for agents.

```bash
npm install caesar-search
```

Works in Node 20+, Bun, Deno, and edge runtimes (standard `fetch`). ESM and CJS, fully typed.

## Quickstart

```ts
import { Caesar } from "caesar-search";

const caesar = new Caesar(); // requires CAESAR_API_KEY (get one at app.trycaesar.com)

const results = await caesar.search("postgres 17 logical replication failover", {
  maxResults: 5,
});

for (const result of results.results ?? []) {
  console.log(result.rank, result.title, result.canonical_url);
}

// Read a result as clean markdown — pass a doc_id or a URL
const doc = await caesar.read(results.results?.[0]?.doc_id, { maxChars: 8000 });
console.log(doc.content?.text);

// Close the loop: feedback improves ranking
await caesar.feedback("result_helpful", {
  searchId: results.search_id,
  docId: results.results?.[0]?.doc_id,
  rank: 1,
});
```

## The agent loop

`search()` → pick a `doc_id` → `read()` → optionally `feedback()`. Results carry provenance handles (`doc_id`, `canonical_url`, `source_url`, crawl dates) so agents can cite and re-fetch exactly what they used.

### Truncated reads

A truncated read sets `content.truncated`. Continue from where it stopped instead of retrying with a bigger cap:

```ts
const next = await caesar.read(docId, {
  startChar: (doc.content?.start_char ?? 0) + (doc.content?.char_count ?? 0),
});
```

### Response shaping

Keep payloads token-efficient with `verbosity` (`ids_only` | `compact` | `standard` | `full`) and a hard budget:

```ts
await caesar.search("query", { verbosity: "compact", maxCharsTotal: 4000 });
```

## File uploads (workspace knowledge base)

Upload your organization's documents and search them alongside the web. `uploadFile()` presigns, PUTs the bytes straight to storage, and (by default) triggers an incremental indexing run:

```ts
import { readFileSync } from "node:fs"; // works in Node, Bun, and Deno

const upload = await caesar.uploadFile({
  filename: "report.pdf",
  data: readFileSync("./report.pdf"),
  contentType: "application/pdf",
});

// Poll until the run completes, then search your workspace.
const status = await caesar.fileIndexStatus(upload.sync_id!);
const hits = await caesar.search("q3 revenue", {
  extraBody: { scope: { indexes: ["workspace"], workspace_id: "<your-org-id>" } },
});

await caesar.listFiles(); // { files: [{ name, size, last_modified }] }
await caesar.deleteFile("report.pdf");
```

Batch several uploads with `index: false`, then call `indexFiles()` once. Supported types match the indexer (pdf, office documents, text, markdown, csv); one file may be up to the server's `max_object_bytes` (100 MB by default).

## Vercel AI SDK tools

The `caesar-search/ai` subpath exports ready-made tools (requires the optional `ai` peer dependency):

```ts
import { generateText } from "ai";
import { caesarTools } from "caesar-search/ai";

const { text } = await generateText({
  model,
  tools: caesarTools(),
  prompt: "What changed in Postgres 17 logical replication?",
});
```

## Configuration

| Option | Environment variable | Default |
|---|---|---|
| `apiKey` | `CAESAR_API_KEY` | required; throws `MissingAPIKeyError` on the public endpoint |
| `baseUrl` | `CAESAR_BASE_URL` | the public endpoint |
| `maxRetries` | — | 3 (429/5xx, honors `Retry-After`) |
| `timeoutMs` | — | 30000 |

## Errors

```ts
import { AuthenticationError, MissingAPIKeyError, RateLimitError, APIStatusError } from "caesar-search";
```

All API errors carry `statusCode`, `code`, `requestId`, and the raw `response`. Connection failures throw `APIConnectionError`; timeouts throw `APITimeoutError`.

## Raw responses

`caesar.withResponse.search(...)` returns `{ data, response }` when you need headers or status.

## Versioning

The client is generated from the live OpenAPI spec (`spec/openapi-public.json`). Non-breaking spec changes release automatically as patch versions; breaking changes are reviewed first. See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
