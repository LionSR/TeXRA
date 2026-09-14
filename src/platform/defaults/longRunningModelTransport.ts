/**
 * The process's HTTP dispatcher for model traffic, installed once at each
 * host root: the environment's proxy policy (`HTTP_PROXY`, `HTTPS_PROXY`,
 * `NO_PROXY`) and the long-stream timeouts a streamed model response needs.
 * Node's native `fetch`, which every `packages/llm` model and provider SDK
 * uses, reads the global dispatcher, so no model constructor takes a
 * transport argument.
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** A streamed reasoning turn may sit silent this long between chunks. */
const MODEL_STREAM_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
/** A synchronous reasoning turn may take this long before its headers. */
const MODEL_RESPONSE_HEADERS_TIMEOUT_MS = 10 * 60 * 1000;

export function installLongRunningModelDispatcher(): void {
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      headersTimeout: MODEL_RESPONSE_HEADERS_TIMEOUT_MS,
      bodyTimeout: MODEL_STREAM_INACTIVITY_TIMEOUT_MS,
    }),
  );
}
