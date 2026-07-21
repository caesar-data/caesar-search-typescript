import {
  APIConnectionError,
  APITimeoutError,
  CaesarError,
  MissingAPIKeyError,
  statusErrorFrom,
} from "./errors";
import type { Client } from "./generated/client";
import { createClient, createConfig } from "./generated/client";
import {
  deleteFile as deleteFileOp,
  getDocument,
  getFilesIndexStatus,
  indexFiles as indexFilesOp,
  listFiles as listFilesOp,
  presignFileUpload,
  recordFeedback,
  search as searchOp,
} from "./generated/sdk.gen";
import type {
  DocumentResponse,
  FeedbackRequest,
  FeedbackResponse,
  FileDeleteResponse,
  FileIndexResponse,
  FileIndexStatusResponse,
  FileListResponse,
  FilePresignResponse,
  SearchRequest,
  SearchResponse,
} from "./generated/types.gen";

export * from "./errors";
export type * from "./generated/types.gen";

export const VERSION = "0.5.0";
export const DEFAULT_BASE_URL = "https://alpha.api.trycaesar.com";

const MAX_DELAY_MS = 8_000;
const BASE_DELAY_MS = 500;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CaesarOptions {
  /** API key; falls back to CAESAR_API_KEY. Required for the public Caesar API. */
  apiKey?: string;
  /** Base URL; falls back to CAESAR_BASE_URL, then the public default. */
  baseUrl?: string;
  /** Retries for 429/5xx responses, honoring Retry-After. Default 3; 0 disables. */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

export interface SearchOptions {
  maxResults?: number;
  sessionId?: string;
  /** Response shaping preset: ids_only | compact | standard | full. */
  verbosity?: "ids_only" | "compact" | "standard" | "full";
  /** Total serialized response budget in characters. */
  maxCharsTotal?: number;
  extraBody?: Record<string, unknown>;
}

export interface ReadOptions {
  docId?: string;
  url?: string;
  query?: string;
  maxChars?: number;
  /** Continue a truncated read from this character offset. */
  startChar?: number;
  include?: string[];
  extraBody?: Record<string, unknown>;
}

export interface FeedbackOptions {
  searchId?: string;
  docId?: string;
  passageId?: string;
  query?: string;
  rank?: number;
  notes?: string;
  extraBody?: Record<string, unknown>;
}

export interface PresignUploadOptions {
  /** MIME type recorded on the stored object. */
  contentType?: string;
}

export interface IndexFilesOptions {
  /** incremental (default) processes new/changed files; full reprocesses everything. */
  mode?: "full" | "incremental";
}

export interface UploadFileOptions {
  /** File bytes. Strings are UTF-8 encoded. */
  data: Blob | ArrayBuffer | Uint8Array | string;
  /** Filename to store the upload under (sanitized server-side). */
  filename: string;
  /** MIME type recorded on the stored object. */
  contentType?: string;
  /**
   * Trigger an incremental indexing run after the upload so the file becomes
   * searchable (default true). Set false to batch several uploads and call
   * indexFiles() once.
   */
  index?: boolean;
}

/** Result of the uploadFile() convenience. Snake_case, matching the API. */
export interface UploadFileResult {
  /** Stored filename (as listed by listFiles / used by deleteFile). */
  name: string;
  /** Indexing run id (poll with fileIndexStatus); absent when index: false. */
  sync_id?: string;
  /** Initial indexing run state; absent when index: false. */
  index_state?: string;
}

function env(name: string): string | undefined {
  // Works in Node, Bun, and edge runtimes that polyfill process.env.
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

function resolveApiKey(apiKey: string | undefined): string | undefined {
  if (apiKey && apiKey.length > 0) return apiKey;
  const envKey = env("CAESAR_API_KEY");
  return envKey && envKey.length > 0 ? envKey : undefined;
}

function isPublicBaseUrl(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, "") === DEFAULT_BASE_URL;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
  }
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSearchBody(query: string, options: SearchOptions): SearchRequest {
  const body: SearchRequest = { query, client_model: "ts-sdk" };
  if (options.maxResults !== undefined) body.max_results = options.maxResults;
  if (options.sessionId) body.session_id = options.sessionId;
  const shape: Record<string, unknown> = {};
  if (options.verbosity) shape.verbosity = options.verbosity;
  if (options.maxCharsTotal !== undefined) shape.budget = { max_chars_total: options.maxCharsTotal };
  if (Object.keys(shape).length > 0) (body as Record<string, unknown>).response = shape;
  return Object.assign(body, options.extraBody);
}

function buildReadBody(target: string | undefined, options: ReadOptions): Record<string, unknown> {
  let { docId, url } = options;
  if (target !== undefined) {
    if (UUID_PATTERN.test(target)) docId = docId ?? target;
    else url = url ?? target;
  }
  if (!docId && !url) throw new TypeError("provide a docId or a url");

  const content: Record<string, unknown> = {
    selection: "full_document",
    format: "markdown",
  };
  if (options.maxChars !== undefined) content.max_chars = options.maxChars;
  if (options.startChar) {
    // Continuation reads address the raw document text so offsets stay
    // contiguous between calls.
    content.selection = "full_document";
    content.range = { start_char: options.startChar };
  }

  const body: Record<string, unknown> = {
    include: options.include ?? ["metadata", "content"],
    content,
  };
  if (docId) body.doc_id = docId;
  else if (url) body.canonical_url = url;
  if (options.query) body.query = options.query;
  return Object.assign(body, options.extraBody);
}

function buildFeedbackBody(eventType: string, options: FeedbackOptions): FeedbackRequest {
  const body = {
    event_type: eventType,
    agent_context: { client_model: "ts-sdk" },
  } as unknown as FeedbackRequest;
  const record = body as Record<string, unknown>;
  if (options.searchId) record.search_id = options.searchId;
  if (options.docId) record.doc_id = options.docId;
  if (options.passageId) record.passage_id = options.passageId;
  if (options.query) record.query = options.query;
  if (options.rank !== undefined) record.rank = options.rank;
  if (options.notes) record.notes = options.notes;
  return Object.assign(body, options.extraBody);
}

function byteLength(data: Blob | ArrayBuffer | Uint8Array | string): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof Blob) return data.size;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.byteLength;
}

function unwrap<T>(result: { data?: T; error?: unknown; response?: Response }): {
  data: T;
  response: Response;
} {
  if (result.error !== undefined || result.data === undefined || result.response === undefined) {
    // The generated client catches exceptions from our fetch wrapper and
    // returns them as `error`; surface connection/timeout errors unchanged.
    if (result.error instanceof CaesarError) throw result.error;
    throw statusErrorFrom(result.error, result.response ?? new Response(null, { status: 500 }));
  }
  return { data: result.data, response: result.response };
}

/** Client for the Caesar search API: search, read, feedback. */
export class Caesar {
  readonly baseUrl: string;
  readonly withResponse: CaesarWithResponse;
  #client: Client;
  #maxRetries: number;
  #timeoutMs: number;

  constructor(options: CaesarOptions = {}) {
    const apiKey = resolveApiKey(options.apiKey);
    this.baseUrl = (options.baseUrl ?? env("CAESAR_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!apiKey && isPublicBaseUrl(this.baseUrl)) throw new MissingAPIKeyError();
    this.#maxRetries = options.maxRetries ?? 3;
    this.#timeoutMs = options.timeoutMs ?? 30_000;

    const headers: Record<string, string> = { "X-Caesar-Client": `ts-sdk/${VERSION}` };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    this.#client = createClient(
      createConfig({
        baseUrl: this.baseUrl,
        headers,
        fetch: ((request: Request) => this.#fetchWithRetry(request)) as typeof fetch,
      }),
    );
    this.withResponse = new CaesarWithResponse(this);
  }

  /** Search the web. Returns ranked results with provenance handles. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    return (await this.searchWithResponse(query, options)).data;
  }

  /**
   * Read a document as clean markdown by doc_id or URL. Truncated reads
   * report content.start_char/char_count; continue with startChar instead of
   * retrying with a bigger maxChars.
   */
  async read(target?: string, options: ReadOptions = {}): Promise<DocumentResponse> {
    return (await this.readWithResponse(target, options)).data;
  }

  /** Send a feedback event about a search result or document. */
  async feedback(eventType: string, options: FeedbackOptions = {}): Promise<FeedbackResponse> {
    return (await this.feedbackWithResponse(eventType, options)).data;
  }

  /**
   * Upload one file to the organization's Files knowledge base: presign, PUT
   * the bytes straight to storage, then (by default) trigger an incremental
   * indexing run so the file becomes searchable via
   * search(query, { extraBody: { scope: { indexes: ["workspace"], workspace_id } } }).
   */
  async uploadFile(options: UploadFileOptions): Promise<UploadFileResult> {
    const { data, filename, contentType, index = true } = options;
    const presigned = await this.presignUpload(filename, byteLength(data), { contentType });
    await this.#putToPresignedUrl(presigned.url, data, contentType);
    if (!index) return { name: presigned.name };
    const started = await this.indexFiles({ mode: "incremental" });
    return { name: presigned.name, sync_id: started.sync_id, index_state: started.state };
  }

  /**
   * Create a presigned upload URL. PUT the raw bytes to it with no
   * Authorization header; the body must be exactly `size` bytes.
   */
  async presignUpload(
    filename: string,
    size: number,
    options: PresignUploadOptions = {},
  ): Promise<FilePresignResponse> {
    return (await this.presignUploadWithResponse(filename, size, options)).data;
  }

  /** List the organization's uploaded files. */
  async listFiles(): Promise<FileListResponse> {
    return (await this.listFilesWithResponse()).data;
  }

  /** Delete one uploaded file by name (as returned by listFiles). */
  async deleteFile(name: string): Promise<FileDeleteResponse> {
    return (await this.deleteFileWithResponse(name)).data;
  }

  /** Start an indexing run over uploaded files. Poll with fileIndexStatus. */
  async indexFiles(options: IndexFilesOptions = {}): Promise<FileIndexResponse> {
    return (await this.indexFilesWithResponse(options)).data;
  }

  /** Progress and outcome of one files indexing run. */
  async fileIndexStatus(syncId: string): Promise<FileIndexStatusResponse> {
    return (await this.fileIndexStatusWithResponse(syncId)).data;
  }

  /** @internal */
  async searchWithResponse(
    query: string,
    options: SearchOptions = {},
  ): Promise<{ data: SearchResponse; response: Response }> {
    return unwrap(await searchOp({ client: this.#client, body: buildSearchBody(query, options) }));
  }

  /** @internal */
  async readWithResponse(
    target?: string,
    options: ReadOptions = {},
  ): Promise<{ data: DocumentResponse; response: Response }> {
    const body = buildReadBody(target, options);
    return unwrap(await getDocument({ client: this.#client, body: body as never }));
  }

  /** @internal */
  async feedbackWithResponse(
    eventType: string,
    options: FeedbackOptions = {},
  ): Promise<{ data: FeedbackResponse; response: Response }> {
    return unwrap(
      await recordFeedback({ client: this.#client, body: buildFeedbackBody(eventType, options) }),
    );
  }

  /** @internal */
  async presignUploadWithResponse(
    filename: string,
    size: number,
    options: PresignUploadOptions = {},
  ): Promise<{ data: FilePresignResponse; response: Response }> {
    const body: Record<string, unknown> = { filename, size };
    if (options.contentType) body.content_type = options.contentType;
    return unwrap(await presignFileUpload({ client: this.#client, body: body as never }));
  }

  /** @internal */
  async listFilesWithResponse(): Promise<{ data: FileListResponse; response: Response }> {
    return unwrap(await listFilesOp({ client: this.#client }));
  }

  /** @internal */
  async deleteFileWithResponse(name: string): Promise<{ data: FileDeleteResponse; response: Response }> {
    return unwrap(await deleteFileOp({ client: this.#client, path: { name } }));
  }

  /** @internal */
  async indexFilesWithResponse(
    options: IndexFilesOptions = {},
  ): Promise<{ data: FileIndexResponse; response: Response }> {
    const body = { mode: options.mode ?? "incremental" };
    return unwrap(await indexFilesOp({ client: this.#client, body: body as never }));
  }

  /** @internal */
  async fileIndexStatusWithResponse(
    syncId: string,
  ): Promise<{ data: FileIndexStatusResponse; response: Response }> {
    return unwrap(await getFilesIndexStatus({ client: this.#client, path: { sync_id: syncId } }));
  }

  /**
   * PUT bytes to a presigned storage URL. Deliberately a bare fetch: the URL
   * is pre-authorized by its signature, so no Authorization header (or any
   * client header) must be attached, and the body must be exactly the
   * presigned size.
   */
  async #putToPresignedUrl(
    url: string,
    data: Blob | ArrayBuffer | Uint8Array | string,
    contentType?: string,
  ): Promise<void> {
    const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "PUT",
        body: body as BodyInit,
        headers: contentType ? { "Content-Type": contentType } : {},
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new APITimeoutError(`upload timed out after ${this.#timeoutMs}ms`);
      }
      throw new APIConnectionError(
        `upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw statusErrorFrom(await response.text().catch(() => undefined), response);
    }
  }

  async #fetchWithRetry(request: Request): Promise<Response> {
    const maxAttempts = this.#maxRetries + 1;
    let response: Response | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Clone before fetching so the original body stream stays unconsumed
      // for later attempts; the final attempt can spend the original.
      const attemptRequest = attempt < maxAttempts - 1 ? request.clone() : request;
      try {
        response = await fetch(attemptRequest, { signal: AbortSignal.timeout(this.#timeoutMs) });
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new APITimeoutError(`request timed out after ${this.#timeoutMs}ms`);
        }
        throw new APIConnectionError(
          `request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (RETRYABLE.has(response.status) && attempt < maxAttempts - 1) {
        await sleep(retryDelayMs(attempt, response.headers.get("Retry-After")));
        continue;
      }
      return response;
    }
    return response as Response;
  }
}

/** The same methods, returning `{ data, response }` for header access. */
export class CaesarWithResponse {
  #client: Caesar;

  constructor(client: Caesar) {
    this.#client = client;
  }

  search(query: string, options: SearchOptions = {}): Promise<{ data: SearchResponse; response: Response }> {
    return this.#client.searchWithResponse(query, options);
  }

  read(target?: string, options: ReadOptions = {}): Promise<{ data: DocumentResponse; response: Response }> {
    return this.#client.readWithResponse(target, options);
  }

  feedback(
    eventType: string,
    options: FeedbackOptions = {},
  ): Promise<{ data: FeedbackResponse; response: Response }> {
    return this.#client.feedbackWithResponse(eventType, options);
  }

  presignUpload(
    filename: string,
    size: number,
    options: PresignUploadOptions = {},
  ): Promise<{ data: FilePresignResponse; response: Response }> {
    return this.#client.presignUploadWithResponse(filename, size, options);
  }

  listFiles(): Promise<{ data: FileListResponse; response: Response }> {
    return this.#client.listFilesWithResponse();
  }

  deleteFile(name: string): Promise<{ data: FileDeleteResponse; response: Response }> {
    return this.#client.deleteFileWithResponse(name);
  }

  indexFiles(options: IndexFilesOptions = {}): Promise<{ data: FileIndexResponse; response: Response }> {
    return this.#client.indexFilesWithResponse(options);
  }

  fileIndexStatus(syncId: string): Promise<{ data: FileIndexStatusResponse; response: Response }> {
    return this.#client.fileIndexStatusWithResponse(syncId);
  }
}
