// Minimal fetch stub for unit tests. Records outgoing requests and returns
// queued Response objects. A `{ throwNetwork: true }` entry simulates fetch's
// behavior under redirect:'error' (a 3xx throws a TypeError, key not re-sent).

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  idempotencyKey?: string;
}

export interface MockResponseSpec {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  throwNetwork?: boolean;
}

export interface MockFetch {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
}

function toResponse(spec: MockResponseSpec): Response {
  const headers = new Headers(spec.headers ?? {});
  let body: string | null = null;
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else if (spec.text !== undefined) {
    body = spec.text;
  }
  return new Response(body, { status: spec.status ?? 200, headers });
}

/** Build a fetch stub from a queue or a per-request function. */
export function makeFetch(
  responder: MockResponseSpec[] | ((req: RecordedRequest) => MockResponseSpec),
): MockFetch {
  const requests: RecordedRequest[] = [];
  const isFn = typeof responder === "function";
  const queue: MockResponseSpec[] | null = isFn ? null : [...(responder as MockResponseSpec[])];

  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const record: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      idempotencyKey: headers["Idempotency-Key"],
    };
    requests.push(record);

    const spec = isFn
      ? (responder as (req: RecordedRequest) => MockResponseSpec)(record)
      : (queue!.shift() ?? { status: 500, json: {} });
    if (spec.throwNetwork) {
      throw new TypeError("Failed to fetch (redirect not allowed)");
    }
    return toResponse(spec);
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

/** A structured DePix error envelope (spec §5.1). */
export function errorEnvelope(
  code: string,
  opts: {
    message?: string;
    request_id?: string;
    retry_after?: number;
    details?: Record<string, unknown>;
    errorMessagePt?: string;
    errors?: Array<{ field: string; message: string }>;
  } = {},
): unknown {
  return {
    response: {
      errorMessage: opts.errorMessagePt ?? "Erro.",
      ...(opts.errors ? { errors: opts.errors } : {}),
    },
    error: {
      code,
      message: opts.message ?? "Error.",
      request_id: opts.request_id ?? "req_test",
      docs_url: "https://depixapp.com/docs/en/#errors",
      ...(opts.retry_after !== undefined ? { retry_after: opts.retry_after } : {}),
      ...(opts.details ? { details: opts.details } : {}),
    },
  };
}
