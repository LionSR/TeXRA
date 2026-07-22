// Third-party imports
import {
  Agent,
  fetch as undiciFetch,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit,
} from 'undici';

/** Long model turns may legitimately pause between streamed response events. */
export const MODEL_STREAM_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

const modelDispatcher = new Agent({
  allowH2: true,
  bodyTimeout: MODEL_STREAM_INACTIVITY_TIMEOUT_MS,
  headersTimeout: 10 * 60 * 1000,
});

/** Fetch transport with an explicit inactivity policy for long model streams. */
export const longRunningModelFetch: typeof fetch = (input, init) =>
  // Undici implements the Web Fetch response contract at runtime, but its
  // package-local types are not assignable to the DOM library's Response.
  undiciFetch(input as UndiciRequestInfo, {
    ...(init as UndiciRequestInit),
    dispatcher: modelDispatcher,
  }) as unknown as Promise<Response>;
