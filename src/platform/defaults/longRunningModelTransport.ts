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
const ROUTING_FETCH_MARKER = Symbol('texra.longRunningModelFetchRouter');
type RoutingFetch = typeof fetch & { [ROUTING_FETCH_MARKER]?: true };
type UploadCompatibleFetch = typeof fetch & { Response: typeof Response };

function isGoogleClassicStreamingRequest(input: RequestInfo | URL): boolean {
  let url: string;
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else if (input instanceof Request) {
    url = input.url;
  } else {
    return false;
  }

  try {
    return new URL(url).pathname.endsWith(':streamGenerateContent');
  } catch {
    // Malformed input cannot identify a Google streaming endpoint.
    return false;
  }
}

async function normalizeModelRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<[UndiciRequestInfo, UndiciRequestInit]> {
  if (!(input instanceof Request)) {
    if (init?.body instanceof FormData) {
      const body = new UndiciFormData();
      for (const [name, value] of init.body.entries()) {
        if (typeof value === 'string') {
          body.append(name, value);
        } else {
          body.append(name, value, value.name);
        }
      }
      return [
        input as UndiciRequestInfo,
        {
          ...init,
          body,
        } as UndiciRequestInit,
      ];
    }
    return [input as UndiciRequestInfo, init as UndiciRequestInit];
  }

  // OpenRouter supplies Node's native Request, while package Undici expects
  // its own branded Request. Rebuild it from interoperable primitives here.
  const request = new Request(input, init);
  const body = request.body === null ? undefined : await request.arrayBuffer();
  return [
    request.url,
    {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      redirect: request.redirect,
      signal: request.signal,
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
 * HTTPClient passes one), so it is rebuilt from interoperable primitives.
 */
export const longRunningModelFetch: UploadCompatibleFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const [requestInput, requestInit] = await normalizeModelRequest(
      input,
      init,
    );
    // Undici implements the Web Fetch response contract at runtime, but its
    // package-local types are not assignable to the DOM library's Response.
    return undiciFetch(requestInput, {
      ...requestInit,
      dispatcher: composeLongRunningModelDispatcher(),
    }) as unknown as Promise<Response>;
  },
  {
    // OpenAI checks this constructor before creating multipart uploads.
    Response,
  },
);

/**
 * Route Google classic streaming generation through the model transport.
 *
 * Only standalone hosts may call this. In particular, the VS Code extension
 * must not wrap fetch for every extension sharing its host process. Google
 * classic `generateContent` has no fetch injection seam, so CLI and desktop
 * intercept only its `:streamGenerateContent` action and preserve the host's
 * fetch implementation for every unrelated request.
 */
export function installLongRunningModelFetch(): void {
  const hostFetch = globalThis.fetch as RoutingFetch;
  if (hostFetch[ROUTING_FETCH_MARKER] === true) return;

  const routingFetch: RoutingFetch = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (isGoogleClassicStreamingRequest(input)) {
      return longRunningModelFetch(input, init);
    }
    return Reflect.apply(hostFetch, this, [input, init]);
  };
  Object.defineProperty(routingFetch, ROUTING_FETCH_MARKER, { value: true });
  globalThis.fetch = routingFetch;
}
