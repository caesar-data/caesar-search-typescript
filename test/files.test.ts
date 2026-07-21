import { describe, expect, test } from "bun:test";
import { APIStatusError, Caesar } from "../src/index";

interface RawCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  text: string;
}

/** Records raw calls (any method, any body) and serves canned JSON per route. */
function rawServer(routes: Record<string, (call: RawCall) => { status?: number; body?: unknown }>) {
  const calls: RawCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const call: RawCall = {
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers.entries()),
        text: await request.text(),
      };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      if (!route) {
        return new Response(JSON.stringify({ error: `no route ${call.method} ${call.path}` }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = route(call);
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

const PRESIGN = (url: string) => ({
  url,
  name: "notes.txt",
  expires_in_seconds: 900,
  max_object_bytes: 104857600,
});

describe("files API", () => {
  test("uploadFile presigns, PUTs the exact bytes without auth, then indexes", async () => {
    const s3 = rawServer({ "PUT /bucket/org/notes.txt": () => ({ status: 200 }) });
    const api = rawServer({
      "POST /v1/files/presign": () => ({ body: PRESIGN(`${s3.url}/bucket/org/notes.txt`) }),
      "POST /v1/files/index": () => ({ status: 202, body: { sync_id: "sync-1", state: "queued" } }),
    });
    try {
      const client = new Caesar({ apiKey: "test-key", baseUrl: api.url });
      const result = await client.uploadFile({
        filename: "notes.txt",
        data: "hello knowledge base",
        contentType: "text/plain",
      });

      expect(result).toEqual({ name: "notes.txt", sync_id: "sync-1", index_state: "queued" });

      const presign = api.calls[0];
      expect(JSON.parse(presign.text)).toEqual({
        filename: "notes.txt",
        size: 20,
        content_type: "text/plain",
      });
      expect(presign.headers.authorization).toBe("Bearer test-key");

      const put = s3.calls[0];
      expect(put.method).toBe("PUT");
      expect(put.text).toBe("hello knowledge base");
      expect(put.headers["content-type"]).toBe("text/plain");
      // The presigned URL is pre-authorized; the API key must never leak to storage.
      expect(put.headers.authorization).toBeUndefined();

      const index = api.calls[1];
      expect(index.path).toBe("/v1/files/index");
      expect(JSON.parse(index.text)).toEqual({ mode: "incremental" });
    } finally {
      api.stop();
      s3.stop();
    }
  });

  test("uploadFile computes the presign size for Blob and ArrayBuffer inputs", async () => {
    const s3 = rawServer({ "PUT /obj": () => ({ status: 200 }) });
    const api = rawServer({
      "POST /v1/files/presign": () => ({ body: PRESIGN(`${s3.url}/obj`) }),
    });
    try {
      const client = new Caesar({ apiKey: "test-key", baseUrl: api.url });

      await client.uploadFile({
        filename: "blob.txt",
        data: new Blob(["12345"]),
        index: false,
      });
      expect(JSON.parse(api.calls[0]?.text ?? "{}").size).toBe(5);

      await client.uploadFile({
        filename: "buffer.bin",
        data: new TextEncoder().encode("1234567").buffer as ArrayBuffer,
        index: false,
      });
      expect(JSON.parse(api.calls[1]?.text ?? "{}").size).toBe(7);
    } finally {
      api.stop();
      s3.stop();
    }
  });

  test("uploadFile with index: false skips the indexing run", async () => {
    const s3 = rawServer({ "PUT /obj": () => ({ status: 200 }) });
    const api = rawServer({
      "POST /v1/files/presign": () => ({ body: PRESIGN(`${s3.url}/obj`) }),
    });
    try {
      const client = new Caesar({ apiKey: "test-key", baseUrl: api.url });
      const result = await client.uploadFile({
        filename: "notes.txt",
        data: new TextEncoder().encode("abc"),
        index: false,
      });
      expect(result).toEqual({ name: "notes.txt" });
      expect(api.calls).toHaveLength(1);
    } finally {
      api.stop();
      s3.stop();
    }
  });

  test("uploadFile surfaces a failed storage PUT as a status error", async () => {
    const s3 = rawServer({ "PUT /obj": () => ({ status: 403, body: "denied" }) });
    const api = rawServer({
      "POST /v1/files/presign": () => ({ body: PRESIGN(`${s3.url}/obj`) }),
    });
    try {
      const client = new Caesar({ apiKey: "test-key", baseUrl: api.url });
      await expect(client.uploadFile({ filename: "notes.txt", data: "abc" })).rejects.toThrow(APIStatusError);
    } finally {
      api.stop();
      s3.stop();
    }
  });

  test("listFiles, deleteFile, indexFiles, and fileIndexStatus hit the right routes", async () => {
    const api = rawServer({
      "GET /v1/files": () => ({
        body: { files: [{ name: "a.pdf", size: 10, last_modified: "2026-01-01T00:00:00Z" }] },
      }),
      "DELETE /v1/files/My%20Report.pdf": () => ({ body: { deleted: true } }),
      "POST /v1/files/index": () => ({ status: 202, body: { sync_id: "s2", state: "planning" } }),
      "GET /v1/files/index/s2": () => ({
        body: {
          sync_id: "s2",
          state: "completed",
          stats: {
            enumerated: 1,
            fetched: 1,
            indexed: 1,
            failed: 0,
            skipped_unsupported: 0,
            deleted: 0,
            bytes: 10,
          },
          error: null,
          started_at: null,
          completed_at: null,
        },
      }),
    });
    try {
      const client = new Caesar({ apiKey: "test-key", baseUrl: api.url });

      const listed = await client.listFiles();
      expect(listed.files?.[0]?.name).toBe("a.pdf");

      const deleted = await client.deleteFile("My Report.pdf");
      expect(deleted.deleted).toBe(true);

      const indexed = await client.indexFiles({ mode: "full" });
      expect(indexed.sync_id).toBe("s2");
      const indexCall = api.calls.find((c) => c.path === "/v1/files/index");
      expect(JSON.parse(indexCall?.text ?? "{}")).toEqual({ mode: "full" });

      const status = await client.fileIndexStatus("s2");
      expect(status.state).toBe("completed");
      expect(status.stats?.indexed).toBe(1);

      for (const call of api.calls) {
        expect(call.headers.authorization).toBe("Bearer test-key");
      }
    } finally {
      api.stop();
    }
  });

  test("presign errors map to typed status errors", async () => {
    const api = rawServer({
      "POST /v1/files/presign": () => ({
        status: 413,
        body: {
          type: "error",
          request_id: "r",
          error: { code: "file_too_large", message: "file exceeds the limit" },
        },
      }),
    });
    try {
      const client = new Caesar({ apiKey: "test-key", baseUrl: api.url });
      let caught: unknown;
      try {
        await client.presignUpload("big.pdf", 999999999999);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(APIStatusError);
      expect((caught as APIStatusError).statusCode).toBe(413);
    } finally {
      api.stop();
    }
  });

  test("withResponse variants expose the raw response", async () => {
    const api = rawServer({
      "GET /v1/files": () => ({ body: { files: [] } }),
    });
    try {
      const client = new Caesar({ apiKey: "test-key", baseUrl: api.url });
      const { data, response } = await client.withResponse.listFiles();
      expect(data.files).toEqual([]);
      expect(response.status).toBe(200);
    } finally {
      api.stop();
    }
  });
});
