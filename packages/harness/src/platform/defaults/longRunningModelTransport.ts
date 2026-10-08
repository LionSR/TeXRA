/**
 * The HTTP transport for model traffic: the environment's proxy policy
 * (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) and the long-stream timeouts a
 * streamed model response needs, which undici's defaults (a 300 s body
 * timeout) cut short.
 *
 * Model traffic carries it as a bound fetch: `ModelAccess` hands
 * {@link modelFetch} to every `packages/llm` model it constructs,
 * so a run gets this transport in any process, the agent package's embedder
 * included, without touching that process's global dispatcher. A host's
 * composition root, which owns its process, also installs the dispatcher
 * globally ({@link installProcessHttpDispatcher}) so the rest of its HTTP
 * traffic follows the same proxy policy.
 */
import { Effect } from 'effect';
import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  setGlobalDispatcher,
} from 'undici';

import { ProjectEnvironment } from '@platform/defaults/nodeWorkspace';

/** A streamed reasoning turn may sit silent this long between chunks. */
const MODEL_STREAM_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
/** A synchronous reasoning turn may take this long before its headers. */
const MODEL_RESPONSE_HEADERS_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Built on first use, not at import: the proxy agent reads the environment
 * when it is constructed, and an embedder may set it after importing.
 */
let dispatcher: EnvHttpProxyAgent | undefined;

const agentOver = (proxy?: ProxyPolicy) =>
  new EnvHttpProxyAgent({
    ...proxy,
    headersTimeout: MODEL_RESPONSE_HEADERS_TIMEOUT_MS,
    bodyTimeout: MODEL_STREAM_INACTIVITY_TIMEOUT_MS,
  });

function modelDispatcher(): EnvHttpProxyAgent {
  dispatcher ??= agentOver();
  return dispatcher;
}

interface ProxyPolicy {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy?: string;
}

/** One agent per proxy policy a project's `.env` names, kept for the
 *  process: a project's runs share its pooled connections. */
const projectDispatchers = new Map<string, EnvHttpProxyAgent>();

/**
 * The fetch every model factory is constructed with. It is undici's own
 * `fetch`, not the global one: the global is the runtime's bundled undici
 * (Electron 44 ships 7.x), which rejects a dispatcher built by this
 * package's undici ("invalid onRequestStart method").
 *
 * For the same reason a `Request` reaches it as a foreign object: the SDKs
 * that build one (Google's, OpenRouter's) construct the runtime's global
 * `Request`, which this undici does not recognize and would stringify to
 * "[object Request]". Its URL, method, headers, body, signal and redirect
 * mode are carried over as an init instead; an explicit `init` still wins.
 * A `Request` body is a stream or null, and only a stream takes `duplex`.
 * The request is held until the fetch settles: a cloned `Request`'s signal
 * follows its parent only while the clone is alive.
 */
const fetchThrough =
  (dispatch: () => EnvHttpProxyAgent): typeof fetch =>
  (input, init) => {
    const request =
      typeof input === 'string' || input instanceof URL ? undefined : input;
    const response = undiciFetch(request?.url ?? (input as string | URL), {
      ...(request && {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        redirect: request.redirect,
        ...(request.body !== null && { duplex: 'half' }),
      }),
      ...init,
      dispatcher: dispatch(),
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
    return request === undefined ? response : response.finally(() => request);
  };

const longRunningModelFetch = fetchThrough(modelDispatcher);

/**
 * The model fetch for the run's project: the process's transport, unless the
 * project's `.env` sets its own proxy policy (`HTTP_PROXY`, `HTTPS_PROXY`,
 * `NO_PROXY`, either case), which then wins over the process's, as every
 * other project variable does. The service holds many projects, so the
 * policy travels with the run rather than through `process.env`.
 */
export const modelFetch = Effect.map(ProjectEnvironment, (project) => {
  // Undici's own order: the lowercase name first; a policy the project
  // leaves unset falls back to the process's.
  const named = (name: string) => project[name.toLowerCase()] ?? project[name];
  const proxy: ProxyPolicy = {
    httpProxy: named('HTTP_PROXY'),
    httpsProxy: named('HTTPS_PROXY'),
    noProxy: named('NO_PROXY'),
  };
  if (Object.values(proxy).every((value) => value === undefined))
    return longRunningModelFetch;
  const key = JSON.stringify(proxy);
  return fetchThrough(() => {
    let agent = projectDispatchers.get(key);
    if (!agent) projectDispatchers.set(key, (agent = agentOver(proxy)));
    return agent;
  });
});

/** A host root's process-wide HTTP dispatcher: the same agent, globally. */
export function installProcessHttpDispatcher(): void {
  setGlobalDispatcher(modelDispatcher());
}
