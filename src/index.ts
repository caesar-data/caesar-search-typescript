import { APIConnectionError, APITimeoutError, CaesarError, statusErrorFrom } from "./errors";
import type { Client } from "./generated/client";
import { createClient, createConfig } from "./generated/client";
import { getDocument, recordFeedback, search as searchOp } from "./generated/sdk.gen";
import type {
  DocumentResponse,
  FeedbackRequest,
  FeedbackResponse,
  SearchRequest,
  SearchResponse,
} from "./generated/types.gen";

export * from "./errors";
export type * from "./generated/types.gen";

export const VERSION = "0.1.3";
export const DEFAULT_BASE_URL = "https://alpha.api.trycaesar.com";

const MAX_DELAY_MS = 8_000;
const BASE_DELAY_MS = 500;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CaesarOptions {
  /** API key; falls back to CAESAR_API_KEY. Anonymous works at a lower rate limit. */
  apiKey?: string;
  /** Base URL; falls back to CAESAR_BASE_URL, then the public default. */
  baseUrl?: string;
  /** Retries for 429/5xx responses, honoring Retry-After. Default 3; 0 disables. */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

export interface SearchOptions {
  mode?: "fast" | "standard" | "research";
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

function env(name: string): string | undefined {
  // Works in Node, Bun, and edge runtimes that polyfill process.env.
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
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
  if (options.mode) body.mode = options.mode;
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
    selection: options.query ? "query_relevant" : "full_document",
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
    const apiKey = options.apiKey ?? env("CAESAR_API_KEY");
    this.baseUrl = (options.baseUrl ?? env("CAESAR_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
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
}
