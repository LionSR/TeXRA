/**
 * Parameterized loopback (browser) OAuth sign-in for subscription providers.
 *
 * Host-neutral Node: binds a local HTTP server on the provider's registered
 * callback port(s), opens the consent URL via an injected `openBrowser`, and
 * waits for the redirect to deliver the authorization code.
 *
 * Worked exemplar for the Effect 4 runtime PRD
 * (`.agents/docs/proposed/architecture/2026-08-26-effect-4-runtime-migration.md`): the server is a
 * scoped resource, the callback wait is a `Deferred` under a timeout, and
 * cancellation is fiber interruption, delivered by the host that runs the
 * program at its own edge. Error identities and HTTP responses are unchanged.
 */
import http from 'node:http';

import { Deferred, Duration, Effect, Fiber, Result } from 'effect';
import { AUTH_CALLBACK_TIMEOUT_MS } from '../config';
import type { HttpClient } from 'effect/unstable/http';

import type { SubscriptionAuthorizeRequest } from './SubscriptionOAuthCoordinator';

/**
 * The loopback route could never be established — the registered callback
 * port(s) could not be bound, or the host could not reach a browser at all.
 * Distinct from every other sign-in failure because nothing was asked of the
 * user yet: a host with a device-code transport can retry on that instead.
 */
export class LoopbackTransportUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LoopbackTransportUnavailableError';
  }
}

/**
 * Minimal coordinator surface the loopback flow needs. The code exchange is a
 * program, not a Promise, so it runs on this flow's own fiber: interrupting
 * the login reaches the token exchange and the session store.
 */
export interface LoopbackOAuthCoordinator<S> {
  buildAuthorizeRequest(port: number): SubscriptionAuthorizeRequest;
  loginWithCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Effect.Effect<S, unknown, HttpClient.HttpClient>;
}

export interface OAuthLoopbackLoginOptions<S> {
  coordinator: LoopbackOAuthCoordinator<S>;
  openBrowser: (url: string) => void | Promise<void>;
  /** Registered callback ports, tried in order. */
  ports: readonly number[];
  /** Path segment of the registered redirect URI (e.g. `/auth/callback`). */
  callbackPath: string;
  /** User-facing provider name in HTML and errors (e.g. `ChatGPT`, `Grok`). */
  displayName: string;
}

function respondHtml(
  res: http.ServerResponse,
  html: string,
  statusCode = 200,
): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function successHtml(displayName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title></head>
<body style="font-family:system-ui;text-align:center;padding-top:4rem">
<h2>Signed in with ${displayName}</h2>
<p>You can close this tab and return to TeXRA.</p>
</body></html>`;
}

const ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in error</title></head>
<body style="font-family:system-ui;text-align:center;padding-top:4rem">
<h2>Sign-in error</h2>
<p>Return to TeXRA and try signing in again.</p>
</body></html>`;

/** One bind attempt; resolves undefined when the port is unavailable. */
function listenAttempt(port: number): Effect.Effect<http.Server | undefined> {
  return Effect.promise(
    () =>
      new Promise((resolve) => {
        const server = http.createServer();
        const onError = () => {
          server.removeListener('listening', onListening);
          server.close();
          resolve(undefined);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve(server);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      }),
  );
}

function bindLoopbackServer(
  ports: readonly number[],
  displayName: string,
): Effect.Effect<
  { server: http.Server; port: number },
  LoopbackTransportUnavailableError
> {
  return Effect.gen(function* () {
    for (const port of ports) {
      const server = yield* listenAttempt(port);
      if (server) return { server, port };
    }
    const portList = ports.join(' or ');
    return yield* Effect.fail(
      new LoopbackTransportUnavailableError(
        `Could not bind the ${displayName} sign-in callback on port ${portList}. ` +
          'Close whatever is using them, or use device-code sign-in instead.',
      ),
    );
  });
}

/**
 * What one callback request asks the login flow to do. Parsed as a pure
 * decision so the Node `http` request callback — a foreign-runtime edge that
 * cannot return an Effect — only interprets it: the URL parse, the one throw
 * risk, sits in `Result.try`, and every fallible branch is a success value.
 */
type CallbackDecision =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'stale-state' }
  | { readonly kind: 'oauth-error'; readonly error: string }
  | { readonly kind: 'missing-code' }
  | { readonly kind: 'code'; readonly code: string };

function decideCallback(
  rawUrl: string | undefined,
  base: string,
  callbackPath: string,
  expectedState: string,
): Result.Result<CallbackDecision, Error> {
  return Result.try({
    try: (): CallbackDecision => {
      const url = new URL(rawUrl ?? '', base);
      if (url.pathname !== callbackPath) {
        return { kind: 'not-found' };
      }
      // A stale or foreign callback answers with the error page but keeps
      // the wait open; only a state-matched callback settles it.
      if (url.searchParams.get('state') !== expectedState) {
        return { kind: 'stale-state' };
      }
      const oauthError = url.searchParams.get('error');
      if (oauthError) {
        return { kind: 'oauth-error', error: oauthError };
      }
      const authCode = url.searchParams.get('code');
      if (!authCode) {
        return { kind: 'missing-code' };
      }
      return { kind: 'code', code: authCode };
    },
    catch: (error) => error as Error,
  });
}

/**
 * The loopback sign-in flow end to end: bind, open the browser, wait for the
 * callback, and persist the session via the coordinator.
 */
export function loginWithOAuthLoopback<S>(
  options: OAuthLoopbackLoginOptions<S>,
): Effect.Effect<S, unknown, HttpClient.HttpClient> {
  const { coordinator, openBrowser, ports, callbackPath, displayName } =
    options;
  // The setup prefix is uninterruptible to preserve the Promise
  // implementation's observable ordering: it bound the server, armed the
  // callback wait, and invoked `openBrowser` before its first cancellation
  // check, so a launcher that never settles must still be started and an
  // abort must still settle the login. The launch promise is consumed on a
  // detached fiber: interruption of the login abandons the join but never
  // the launcher, and a late launch failure dies on that fiber with a typed
  // error — observed and inert — where the old code swallowed a late
  // rejection with a `.catch` no-op. Interruption is observed from the
  // launcher join onward — the same points the old code raced against its
  // cancellation promise.
  const setup = Effect.uninterruptible(
    Effect.gen(function* () {
      const { server, port } = yield* Effect.acquireRelease(
        bindLoopbackServer(ports, displayName),
        (bound) =>
          Effect.sync(() => {
            bound.server.close();
          }),
      );
      const authorize = coordinator.buildAuthorizeRequest(port);
      const code = yield* Deferred.make<string, Error>();

      const onRequest = (
        req: http.IncomingMessage,
        res: http.ServerResponse,
      ): void => {
        const decision = decideCallback(
          req.url,
          `http://127.0.0.1:${port}`,
          callbackPath,
          authorize.state,
        );
        if (Result.isFailure(decision)) {
          res.statusCode = 500;
          res.end('Internal error');
          Deferred.doneUnsafe(code, Effect.fail(decision.failure));
          return;
        }
        switch (decision.success.kind) {
          case 'not-found':
            res.statusCode = 404;
            res.end('Not found');
            return;
          case 'stale-state':
          case 'missing-code':
            respondHtml(res, ERROR_HTML, 400);
            return;
          case 'oauth-error':
            respondHtml(res, ERROR_HTML, 400);
            Deferred.doneUnsafe(
              code,
              Effect.fail(
                new Error(
                  `${displayName} sign-in failed: ${decision.success.error}`,
                ),
              ),
            );
            return;
          case 'code':
            respondHtml(res, successHtml(displayName));
            Deferred.doneUnsafe(code, Effect.succeed(decision.success.code));
            return;
        }
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => server.on('request', onRequest)),
        () =>
          Effect.sync(() => {
            server.off('request', onRequest);
          }),
      );

      // Invoked synchronously here (the old Promise code's ordering), then
      // observed by the detached fiber the login joins below.
      const launchPromise = Promise.resolve(openBrowser(authorize.url));
      const browserLaunch = yield* Effect.forkDetach(
        Effect.tryPromise<void, unknown>({
          try: () => launchPromise,
          catch: (error) => error,
        }),
      );
      return { authorize, code, browserLaunch };
    }),
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const { authorize, code, browserLaunch } = yield* setup;

      yield* Fiber.join(browserLaunch);

      const authCode = yield* Deferred.await(code).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(AUTH_CALLBACK_TIMEOUT_MS),
          orElse: () =>
            Effect.fail(
              new Error(
                `Timed out waiting for the ${displayName} sign-in callback.`,
              ),
            ),
        }),
      );

      return yield* coordinator.loginWithCode({
        code: authCode,
        verifier: authorize.verifier,
        redirectUri: authorize.redirectUri,
      });
    }),
  );
}
