/**
 * Vercel AI SDK tool exports. Requires the `ai` package (peer dependency):
 *
 * ```ts
 * import { caesarTools } from "caesar-search/ai";
 * const result = await generateText({ model, tools: caesarTools(), prompt });
 * ```
 */
import { jsonSchema, tool } from "ai";
import { Caesar } from "./index";

export interface CaesarToolsOptions {
  client?: Caesar;
}

export function caesarTools(options: CaesarToolsOptions = {}) {
  const client = options.client ?? new Caesar();

  const caesarSearchTool = tool({
    description:
      "Search the web. Returns ranked results with snippets and provenance handles (doc_id, URLs, crawl dates). Use caesar_read or web_fetch with a result's doc_id or url to read full content.",
    inputSchema: jsonSchema<{
      query: string;
      max_results?: number;
      response_format?: "compact" | "standard" | "full";
    }>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search query. Put constraints directly in the query text (site, filetype, exact phrases, recency).",
        },
        max_results: { type: "number", description: "Maximum results, 1-50. Default 8." },
        response_format: {
          type: "string",
          enum: ["compact", "standard", "full"],
          description: "Result detail. compact (default) is the token-efficient choice.",
        },
      },
      required: ["query"],
    }),
    execute: async ({ query, max_results, response_format }) =>
      client.search(query, {
        maxResults: max_results ?? 8,
        verbosity: response_format ?? "compact",
      }),
  });

  const caesarReadTool = tool({
    description:
      "Read a web page as clean markdown with document metadata and provenance. Accepts a url or a doc_id returned by caesar_search or web_search.",
    inputSchema: jsonSchema<{
      target: string;
      query?: string;
      max_chars?: number;
      start_char?: number;
    }>({
      type: "object",
      properties: {
        target: { type: "string", description: "URL or doc_id to read." },
        query: { type: "string", description: "Optional question to focus content selection." },
        max_chars: { type: "number", description: "Content character cap. Default 12000." },
        start_char: {
          type: "number",
          description: "Resume a truncated read from this character offset.",
        },
      },
      required: ["target"],
    }),
    execute: async ({ target, query, max_chars, start_char }) =>
      client.read(target, { query, maxChars: max_chars, startChar: start_char }),
  });

  return {
    caesar_search: caesarSearchTool,
    caesar_read: caesarReadTool,
    web_search: caesarSearchTool,
    web_fetch: caesarReadTool,
  };
}
