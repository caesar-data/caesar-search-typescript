export class CaesarError extends Error {}

export class APIConnectionError extends CaesarError {}

export class APITimeoutError extends APIConnectionError {}

export class APIStatusError extends CaesarError {
  readonly statusCode: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly response: Response;

  constructor(args: {
    statusCode: number;
    code: string;
    message: string;
    requestId?: string;
    response: Response;
  }) {
    super(`${args.code}: ${args.message}`);
    this.statusCode = args.statusCode;
    this.code = args.code;
    this.requestId = args.requestId;
    this.response = args.response;
  }
}

export class AuthenticationError extends APIStatusError {}

export class RateLimitError extends APIStatusError {}

interface ErrorEnvelopeLike {
  request_id?: string;
  error?: { code?: string; message?: string };
}

export function statusErrorFrom(body: unknown, response: Response): APIStatusError {
  const envelope = (body ?? {}) as ErrorEnvelopeLike;
  const args = {
    statusCode: response.status,
    code: envelope.error?.code ?? `http_${response.status}`,
    message: envelope.error?.message ?? `API request failed with status ${response.status}`,
    requestId: envelope.request_id,
    response,
  };
  if (response.status === 401 || response.status === 403) return new AuthenticationError(args);
  if (response.status === 429) return new RateLimitError(args);
  return new APIStatusError(args);
}
