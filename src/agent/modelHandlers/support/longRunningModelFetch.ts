// Third-party imports
import {
  fetch as undiciFetch,
  getGlobalDispatcher,
  type Dispatcher,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit,
} from 'undici';

/** Long model turns may legitimately pause between streamed response events. */
export const MODEL_STREAM_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

async function normalizeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<[UndiciRequestInfo, UndiciRequestInit]> {
  if (!(input instanceof Request)) {
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
        headersTimeout: 10 * 60 * 1000,
      },
      handler,
    );

/** Fetch transport with long-stream timeouts and the host's current proxy policy. */
export const longRunningModelFetch: typeof fetch = async (input, init) => {
  const [requestInput, requestInit] = await normalizeRequest(input, init);
  const dispatcher = getGlobalDispatcher().compose(withLongStreamTimeouts);
  // Undici implements the Web Fetch response contract at runtime, but its
  // package-local types are not assignable to the DOM library's Response.
  return undiciFetch(requestInput, {
    ...requestInit,
    dispatcher,
  }) as unknown as Promise<Response>;
};
