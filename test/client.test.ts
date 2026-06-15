import { describe, expect, test } from "bun:test";
import { APIStatusError, APITimeoutError, AuthenticationError, Caesar, RateLimitError } from "../src/index";

interface MockCall {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function mockServer(
  handler: (
    call: MockCall,
    index: number,
  ) => { status?: number; headers?: Record<string, string>; body: unknown },
) {
  const calls: MockCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const call: MockCall = {
        path: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers.entries()),
        body: (await request.json()) as Record<string, unknown>,
      };
      calls.push(call);
      const result = handler(call, calls.length - 1);
      return new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { "Content-Type": "application/json", ...(result.headers ?? {}) },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

const SAMPLE_SEARCH = {
  request_id: "11111111-1111-4111-8111-111111111111",
  search_id: "22222222-2222-4222-8222-222222222222",
  session_id: "33333333-3333-4333-8333-333333333333",
  access: {
    tier: "api_key",
    rate_limit: { limit_rps: 100, remaining: 99, reset_at: "2026-06-12T00:00:00Z" },
  },
  ranking: { mode: "standard", ranker_version: "reranked_v1", score_scope: "response_local" },
  results: [
    {
      rank: 1,
      doc_id: "44444444-4444-4444-8444-444444444444",
      canonical_url: "https://example.com/one",
      source_url: "https://example.com/one?utm=x",
      title: "Example One",
      snippet: "First snippet.",
      metadata: { published_at: "2026-06-01T00:00:00Z", last_crawled_at: "2026-06-12T00:00:00Z" },
    },
  ],
  usage: { requests: 1, bytes_returned: 1000, approx_tokens: 250 },
};

describe("Caesar client", () => {
  test("search returns typed data with provenance and maps options", async () => {
    const server = mockServer(() => ({ body: SAMPLE_SEARCH }));
    const client = new Caesar({ apiKey: "test-key", baseUrl: server.url });
    const data = await client.search("test query", {
      mode: "fast",
      maxResults: 7,
      verbosity: "compact",
      maxCharsTotal: 4000,
    });
    server.stop();

    expect(data.search_id).toBe(SAMPLE_SEARCH.search_id);
    expect(data.results?.[0]?.doc_id).toBe("44444444-4444-4444-8444-444444444444");
    expect(data.results?.[0]?.canonical_url).toBe("https://example.com/one");
    expect(data.results?.[0]?.source_url).toBe("https://example.com/one?utm=x");

    const body = server.calls[0]?.body ?? {};
    expect(body.query).toBe("test query");
    expect(body.mode).toBe("fast");
    expect(body.max_results).toBe(7);
    expect(body.response).toEqual({ verbosity: "compact", budget: { max_chars_total: 4000 } });
    expect(body.client_model).toBe("ts-sdk");
  });

  test("sends auth and attribution headers", async () => {
    const server = mockServer(() => ({ body: SAMPLE_SEARCH }));
    const client = new Caesar({ apiKey: "sdk-test-key", baseUrl: server.url });
    await client.search("q");
    server.stop();
    expect(server.calls[0]?.headers.authorization).toBe("Bearer sdk-test-key");
    expect(server.calls[0]?.headers["x-caesar-client"]).toStartWith("ts-sdk/");
  });

  test("read maps doc_id, url, and start_char range", async () => {
    const server = mockServer(() => ({ body: { doc: { doc_id: "x" } } }));
    const client = new Caesar({ apiKey: "k", baseUrl: server.url });
    await client.read("44444444-4444-4444-8444-444444444444", { maxChars: 500 });
    await client.read("https://example.com/page", { query: "what is it" });
    await client.read(undefined, { docId: "44444444-4444-4444-8444-444444444444", startChar: 100 });
    server.stop();

    const byDoc = server.calls[0]?.body ?? {};
    expect(byDoc.doc_id).toBe("44444444-4444-4444-8444-444444444444");
    expect((byDoc.content as Record<string, unknown>).selection).toBe("full_document");

    const byUrl = server.calls[1]?.body ?? {};
    expect(byUrl.canonical_url).toBe("https://example.com/page");
    expect((byUrl.content as Record<string, unknown>).selection).toBe("query_relevant");

    const byRange = server.calls[2]?.body ?? {};
    expect((byRange.content as Record<string, unknown>).range).toEqual({ start_char: 100 });
  });

  test("read without target throws TypeError", async () => {
    const client = new Caesar({ apiKey: "k", baseUrl: "http://127.0.0.1:1" });
    await expect(client.read()).rejects.toBeInstanceOf(TypeError);
  });

  test("feedback maps fields", async () => {
    const server = mockServer(() => ({ body: { accepted: true } }));
    const client = new Caesar({ apiKey: "k", baseUrl: server.url });
    const data = await client.feedback("result_helpful", { searchId: "s1", docId: "d1", rank: 2 });
    server.stop();
    expect(data.accepted).toBe(true);
    const body = server.calls[0]?.body ?? {};
    expect(body.event_type).toBe("result_helpful");
    expect(body.search_id).toBe("s1");
    expect(body.rank).toBe(2);
  });

  test("retries 429 honoring Retry-After then succeeds", async () => {
    const server = mockServer((_call, index) =>
      index === 0
        ? { status: 429, headers: { "Retry-After": "0" }, body: { error: { code: "rate_limited" } } }
        : { body: SAMPLE_SEARCH },
    );
    const client = new Caesar({ apiKey: "k", baseUrl: server.url });
    const data = await client.search("q");
    server.stop();
    expect(data.search_id).toBeTruthy();
    expect(server.calls.length).toBe(2);
  });

  test("maxRetries 0 disables retries and maps RateLimitError", async () => {
    const server = mockServer(() => ({
      status: 429,
      body: { request_id: "r1", error: { code: "rate_limited", message: "slow down" } },
    }));
    const client = new Caesar({ apiKey: "k", baseUrl: server.url, maxRetries: 0 });
    try {
      await client.search("q");
      throw new Error("expected RateLimitError");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).code).toBe("rate_limited");
      expect((error as RateLimitError).requestId).toBe("r1");
    }
    server.stop();
    expect(server.calls.length).toBe(1);
  });

  test("401 maps to AuthenticationError", async () => {
    const server = mockServer(() => ({
      status: 401,
      body: { error: { code: "missing_api_key", message: "missing API key" } },
    }));
    const client = new Caesar({ baseUrl: server.url, maxRetries: 0 });
    await expect(client.search("q")).rejects.toBeInstanceOf(AuthenticationError);
    server.stop();
  });

  test("500 after retries maps to APIStatusError", async () => {
    const server = mockServer(() => ({ status: 500, body: { error: { code: "internal_error" } } }));
    const client = new Caesar({ apiKey: "k", baseUrl: server.url, maxRetries: 1 });
    try {
      await client.search("q");
      throw new Error("expected APIStatusError");
    } catch (error) {
      expect(error).toBeInstanceOf(APIStatusError);
    }
    server.stop();
    expect(server.calls.length).toBe(2);
  });

  test("timeout maps to APITimeoutError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(3000);
        return new Response("{}");
      },
    });
    const client = new Caesar({ apiKey: "k", baseUrl: `http://127.0.0.1:${server.port}`, timeoutMs: 300 });
    await expect(client.search("q")).rejects.toBeInstanceOf(APITimeoutError);
    server.stop(true);
  }, 10_000);

  test("withResponse exposes the raw Response", async () => {
    const server = mockServer(() => ({ body: SAMPLE_SEARCH }));
    const client = new Caesar({ apiKey: "k", baseUrl: server.url });
    const { data, response } = await client.withResponse.search("q");
    server.stop();
    expect(data.search_id).toBe(SAMPLE_SEARCH.search_id);
    expect(response.status).toBe(200);
  });

  test("apiKey option beats environment", async () => {
    const server = mockServer(() => ({ body: SAMPLE_SEARCH }));
    process.env.CAESAR_API_KEY = "env-key";
    try {
      const client = new Caesar({ apiKey: "arg-key", baseUrl: server.url });
      await client.search("q");
    } finally {
      delete process.env.CAESAR_API_KEY;
    }
    server.stop();
    expect(server.calls[0]?.headers.authorization).toBe("Bearer arg-key");
  });
});

describe("AI SDK tools", () => {
  test("caesarTools exposes branded and generic web tools that call the API", async () => {
    const { caesarTools } = await import("../src/ai");
    const server = mockServer(() => ({ body: SAMPLE_SEARCH }));
    const tools = caesarTools({ client: new Caesar({ apiKey: "k", baseUrl: server.url }) });
    expect(Object.keys(tools).sort()).toEqual([
      "caesar_read",
      "caesar_search",
      "web_fetch",
      "web_search",
    ]);

    const execute = tools.web_search.execute;
    if (!execute) throw new Error("web_search tool has no execute");
    const result = (await execute(
      { query: "tool query", max_results: 2 },
      { toolCallId: "t1", messages: [] },
    )) as typeof SAMPLE_SEARCH;
    server.stop();
    expect(result.search_id).toBe(SAMPLE_SEARCH.search_id);
    const body = server.calls[0]?.body ?? {};
    expect(body.max_results).toBe(2);
    expect(body.response).toEqual({ verbosity: "compact" });
  });
});
