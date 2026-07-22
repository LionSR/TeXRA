// Third-party imports
import {
  Agent,
  fetch as undiciFetch,
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

/** Handler-owned fetch transport for long model streams. */
export class LongRunningModelTransport {
  private dispatcher: Agent | undefined;
  private disposed = false;

  constructor(dispatcher?: Agent) {
    this.dispatcher = dispatcher;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.disposed) {
      throw new Error('Long-running model transport has been disposed.');
    }
    this.dispatcher ??= new Agent({
      allowH2: true,
      bodyTimeout: MODEL_STREAM_INACTIVITY_TIMEOUT_MS,
      headersTimeout: 10 * 60 * 1000,
    });
    const [requestInput, requestInit] = await normalizeRequest(input, init);
    // Undici implements the Web Fetch response contract at runtime, but its
    // package-local types are not assignable to the DOM library's Response.
    return undiciFetch(requestInput, {
      ...requestInit,
      dispatcher: this.dispatcher,
    }) as unknown as Promise<Response>;
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const dispatcher = this.dispatcher;
    this.dispatcher = undefined;
    dispatcher?.close(() => undefined);
  }
}
