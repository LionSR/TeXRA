// Third-party imports
import {
  fetch as undiciFetch,
  FormData as UndiciFormData,
  getGlobalDispatcher,
  type Dispatcher,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit,
} from 'undici';

const MODEL_STREAM_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const MODEL_RESPONSE_HEADERS_TIMEOUT_MS = 10 * 60 * 1000;
type UploadCompatibleFetch = typeof fetch & { Response: typeof Response };

/**
 * Detect a WHATWG ReadableStream without `instanceof`. A stream constructed
 * in another realm (worker_threads, a second vendored `node:stream/web`)
 * fails the brand check and would otherwise miss the `duplex` hint.
 */
function isReadableStreamBody(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { pipeTo?: unknown }).pipeTo === 'function'
  );
}

/**
 * Detect a WHATWG Request without `instanceof`, which a Request constructed
 * in another realm (the worker-thread scenario above) fails. Probing `url`
 * plus `arrayBuffer` also excludes the `string` and `URL` inputs.
 */
function isRequestLike(input: RequestInfo | URL): input is Request {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { url?: unknown }).url === 'string' &&
    typeof (input as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  );
}

/** Headers from any realm flatten through their own `entries` iterator. */
function flattenHeaders(
  headers: UndiciRequestInit['headers'] | Headers,
): UndiciRequestInit['headers'] {
  // Array-form HeadersInit ([string, string][]) has its own `entries` —
  // index/value pairs, not header tuples — so it must fall through untouched;
  // undici accepts the tuple form directly.
  if (
    typeof headers === 'object' &&
    headers !== null &&
    !Array.isArray(headers) &&
    typeof (headers as { entries?: unknown }).entries === 'function'
  ) {
    return Object.fromEntries((headers as Headers).entries());
  }
  return headers as UndiciRequestInit['headers'];
}

async function normalizeModelRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<[UndiciRequestInfo, UndiciRequestInit]> {
  // Only ReadableStream bodies require the WHATWG `duplex` hint. String,
  // FormData, and ArrayBuffer bodies must stay free of it; undici tolerates the
  // field on non-stream bodies today, but the Fetch spec does not.
  const requestInit = { ...(init ?? {}) } as UndiciRequestInit;
  if (isReadableStreamBody(requestInit.body) && requestInit.duplex == null) {
    requestInit.duplex = 'half';
  }
  const initBody = init?.body;
  if (initBody instanceof FormData) {
    // OpenAI builds multipart bodies with the host-global FormData, while
    // package Undici recognizes only its own FormData implementation.
    const body = new UndiciFormData();
    for (const [name, value] of initBody.entries()) {
      if (typeof value === 'string') {
        body.append(name, value);
      } else {
        body.append(name, value, value.name);
      }
    }
    requestInit.body = body;
  }
  if (!isRequestLike(input)) {
    return [input as UndiciRequestInfo, requestInit];
  }

  // OpenRouter supplies Node's native Request, while package Undici expects
  // its own branded Request. Rebuild it from interoperable primitives here —
  // property reads plus the input's own `arrayBuffer`, never
  // `new Request(input, ...)`: that constructor brand-checks its argument and
  // would reject a cross-realm Request the same way `instanceof` did.
  //
  // The field precedence below mirrors `new Request(input, init)`: an init
  // header set REPLACES the input's wholesale (the constructor empties the
  // copied list before filling it — verified against undici's constructor),
  // so `??` here is parity, not a merge; only a non-null init body overrides
  // (null/undefined keep the input's body); a null signal detaches where an
  // absent one inherits.
  const headers = requestInit.headers ?? input.headers;
  let body: UndiciRequestInit['body'];
  if (requestInit.body != null) {
    body = requestInit.body;
  } else if (input.body !== null) {
    body = await input.arrayBuffer();
  }
  return [
    input.url,
    {
      method: requestInit.method ?? input.method,
      headers: flattenHeaders(headers),
      redirect: requestInit.redirect ?? input.redirect,
      signal:
        requestInit.signal === undefined ? input.signal : requestInit.signal,
      // Set (or defaulted) above for stream bodies; undici rejects a stream
      // body without the hint.
      ...(requestInit.duplex === undefined
        ? {}
        : { duplex: requestInit.duplex }),
      ...(body === undefined ? {} : { body }),
    },
  ];
}

const withLongStreamTimeouts =
  (dispatch: Dispatcher['dispatch']): Dispatcher['dispatch'] =>
  (options, handler) =>
    dispatch(
      {
        ...options,
        bodyTimeout: MODEL_STREAM_INACTIVITY_TIMEOUT_MS,
        headersTimeout: MODEL_RESPONSE_HEADERS_TIMEOUT_MS,
      },
      handler,
    );

/** Composes the host's current dispatcher (proxy policy stays host-owned) with
 *  the long-stream timeouts. Composed per call so a runtime proxy change is
 *  honored by the next request. */
export function composeLongRunningModelDispatcher(): Dispatcher {
  return getGlobalDispatcher().compose(withLongStreamTimeouts);
}

/**
 * Fetch transport with long-stream timeouts and the host's current proxy
 * policy.
 *
 * Deliberately package-undici fetch, not the SDKs' `fetchOptions.dispatcher`
 * seam over native fetch: pairing this package's fetch with this package's
 * composed dispatcher keeps the dispatch-handler interface version-locked,
 * where native fetch would couple our dispatcher to whatever undici the host
 * Node embeds. That same choice is why {@link normalizeModelRequest} exists —
 * package-undici fetch rejects native `Request` instances (OpenRouter's
 * HTTPClient passes one) and does not serialize host-global `FormData`
 * instances (OpenAI's audio client passes one), so both are translated at
 * this boundary.
 */
const longRunningModelFetchImpl: typeof fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const [requestInput, requestInit] = await normalizeModelRequest(input, init);
  // Undici implements the Web Fetch response contract at runtime, but its
  // package-local types are not assignable to the DOM library's Response.
  return undiciFetch(requestInput, {
    ...requestInit,
    dispatcher: composeLongRunningModelDispatcher(),
  }) as unknown as Promise<Response>;
};
// OpenAI checks this constructor before creating multipart uploads.
Object.defineProperty(longRunningModelFetchImpl, 'Response', {
  value: Response,
});
export const longRunningModelFetch =
  longRunningModelFetchImpl as UploadCompatibleFetch;
