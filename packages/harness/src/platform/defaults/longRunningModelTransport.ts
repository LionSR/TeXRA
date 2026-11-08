/**
 * The HTTP transport for model traffic: the environment's proxy policy
 * (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) and the long-stream timeouts a
 * streamed model response needs, which undici's defaults (a 300 s body
 * timeout) cut short.
 *
 * Model traffic carries it as a bound fetch: `ModelAccess` hands
 * {@link runModelFetch} to every `packages/llm` model it constructs,
 * so a run gets this transport in any process, the agent package's embedder
 * included, without touching that process's global dispatcher. A host's
 * composition root, which owns its process, also installs the dispatcher
 * globally ({@link installProcessHttpDispatcher}) so the rest of its HTTP
 * traffic follows the same proxy policy. An embedder that supplies its own
 * fetch ({@link ModelFetch}) replaces this transport for every model request.
 */
import { Context, Effect, Option } from 'effect';
import {
  type Dispatcher,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  setGlobalDispatcher,
} from 'undici';

import { ProjectEnvironment } from '@utils/system/nodeWorkspace';

/** A streamed reasoning turn may sit silent this long between chunks. */
const MODEL_STREAM_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
/** A synchronous reasoning turn may take this long before its headers. */
const MODEL_RESPONSE_HEADERS_TIMEOUT_MS = 10 * 60 * 1000;

/** A project's proxy policy, as undici's agent options name it; a field
 *  left unset falls back to the process's environment. */
interface ProxyPolicy {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy?: string;
}

/**
 * The undici agents this process's HTTP traffic goes through, by use and
 * proxy policy. An agent is built on first use, not at import (it reads the
 * environment when it is constructed, and an embedder may set it after
 * importing), and kept for the process, so a project's runs share its
 * pooled connections.
 */
const HttpAgents = Context.Reference<Map<string, Dispatcher>>(
  '@texra-ai/harness/HttpAgents',
  { defaultValue: () => new Map() },
);

/**
 * The agent for `use` under the work's proxy policy: the project's `.env`
 * `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (either case) over the
 * process's, as every other project variable wins. The service holds many
 * projects, so the policy travels with the work rather than through
 * `process.env`. `options` are the use's own, the same for every policy.
 */
export const proxyAgent = (
  use: 'model' | 'web',
  options: Omit<EnvHttpProxyAgent.Options, keyof ProxyPolicy>,
): Effect.Effect<Dispatcher> =>
  Effect.gen(function* () {
    const agents = yield* HttpAgents;
    const project = yield* ProjectEnvironment;
    // Undici's own order: the lowercase name first.
    const named = (name: string) =>
      project[name.toLowerCase()] ?? project[name];
    const proxy: ProxyPolicy = {
      httpProxy: named('HTTP_PROXY'),
      httpsProxy: named('HTTPS_PROXY'),
      noProxy: named('NO_PROXY'),
    };
    const key = JSON.stringify([use, proxy]);
    let agent = agents.get(key);
    if (!agent)
      agents.set(
        key,
        (agent = new EnvHttpProxyAgent({ ...options, ...proxy })),
      );
    return agent;
  });

const modelAgent = proxyAgent('model', {
  headersTimeout: MODEL_RESPONSE_HEADERS_TIMEOUT_MS,
  bodyTimeout: MODEL_STREAM_INACTIVITY_TIMEOUT_MS,
});

/**
 * undici's `fetch` under the DOM signature the rest of the codebase speaks,
 * plus undici's `dispatcher` option.
 */
// undici implements the DOM fetch, but its `RequestInfo`, `RequestInit` and
// `Response` typings lag the DOM lib's (a `Headers` iterator without
// `Symbol.dispose`, other `BodyInit` view types), so they are not assignable.
// cast: the same function, under the DOM typings it implements.
const domUndiciFetch = undiciFetch as unknown as (
  input: Parameters<typeof fetch>[0],
  init: RequestInit & { readonly dispatcher: Dispatcher },
) => Promise<Response>;

/** undici's `fetch` through `dispatcher`, as the DOM `fetch` types it. */
export const undiciFetchThrough = (
  dispatcher: Dispatcher,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> => domUndiciFetch(input, { ...init, dispatcher });

/**
 * The fetch every model factory is constructed with. It is undici's own
 * `fetch`, not the global one: the global is the runtime's bundled undici
 * (Electron 44 ships 7.x), which rejects a dispatcher built by this
 * package's undici ("invalid onRequestStart method").
 *
 * For the same reason a `Request` reaches it as a foreign object: the SDKs
 * that build one (Google's) construct the runtime's global
 * `Request`, which this undici does not recognize and would stringify to
 * "[object Request]". Its URL, method, headers, body, signal and redirect
 * mode are carried over as an init instead; an explicit `init` still wins.
 * A `Request` body is a stream or null, and only a stream takes `duplex`.
 * The request is held until the fetch settles: a cloned `Request`'s signal
 * follows its parent only while the clone is alive.
 */
const fetchThrough =
  (dispatcher: Dispatcher): typeof fetch =>
  (input, init) => {
    if (typeof input === 'string' || input instanceof URL)
      return undiciFetchThrough(dispatcher, input, init);
    const request = input;
    return undiciFetchThrough(dispatcher, request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      redirect: request.redirect,
      ...(request.body !== null && { duplex: 'half' }),
      ...init,
    }).finally(() => request);
  };

/**
 * The fetch every model request of the process's runs goes through, when the
 * embedder supplies one: a fake model for a test or an example, a recording
 * or instrumented transport. Merge it beneath `Sessions.layer` (or
 * `processLayer`) with `Layer.provideMerge`, so it stays in the context the
 * runs read; the supplied fetch then owns the proxy policy and the timeouts
 * too. Absent, the harness's own transport carries model traffic:
 * the environment's proxy policy, a project's `.env` proxy over it, and the
 * long-stream timeouts a streamed reasoning turn needs. A service read as an
 * option, not a `Context.Reference`, because that default depends on the
 * run's project.
 */
export class ModelFetch extends Context.Service<ModelFetch, typeof fetch>()(
  '@texra-ai/harness/ModelFetch',
) {}

/**
 * The model fetch for the run's project: the embedder's {@link ModelFetch},
 * else the process's transport under the project's proxy policy
 * ({@link proxyAgent}).
 */
export const runModelFetch = Effect.gen(function* () {
  const supplied = yield* Effect.serviceOption(ModelFetch);
  if (Option.isSome(supplied)) return supplied.value;
  return fetchThrough(yield* modelAgent);
});

/** A host root's process-wide HTTP dispatcher: the process's model agent,
 *  globally. */
export const installProcessHttpDispatcher: Effect.Effect<void> = Effect.map(
  modelAgent,
  setGlobalDispatcher,
);
