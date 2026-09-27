/**
 * The HTTP transport for model traffic: the environment's proxy policy
 * (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) and the long-stream timeouts a
 * streamed model response needs, which undici's defaults (a 300 s body
 * timeout) cut short.
 *
 * Model traffic carries it as a bound fetch: `modelBinding` hands
 * {@link longRunningModelFetch} to every `packages/llm` model it constructs,
 * so a run gets this transport in any process, the agent package's embedder
 * included, without touching that process's global dispatcher. A host's
 * composition root, which owns its process, also installs the dispatcher
 * globally ({@link installProcessHttpDispatcher}) so the rest of its HTTP
 * traffic follows the same proxy policy.
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** A streamed reasoning turn may sit silent this long between chunks. */
const MODEL_STREAM_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
/** A synchronous reasoning turn may take this long before its headers. */
const MODEL_RESPONSE_HEADERS_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Built on first use, not at import: the proxy agent reads the environment
 * when it is constructed, and an embedder may set it after importing.
 */
let dispatcher: EnvHttpProxyAgent | undefined;

function modelDispatcher(): EnvHttpProxyAgent {
  dispatcher ??= new EnvHttpProxyAgent({
    headersTimeout: MODEL_RESPONSE_HEADERS_TIMEOUT_MS,
    bodyTimeout: MODEL_STREAM_INACTIVITY_TIMEOUT_MS,
  });
  return dispatcher;
}

/** The fetch every model factory is constructed with. */
export const longRunningModelFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    // Node's fetch is undici's and honors a per-request dispatcher; the DOM
    // `RequestInit` type does not name the field.
    dispatcher: modelDispatcher(),
  } as RequestInit);

/** A host root's process-wide HTTP dispatcher: the same agent, globally. */
export function installProcessHttpDispatcher(): void {
  setGlobalDispatcher(modelDispatcher());
}
