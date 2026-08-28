/**
 * Parameterized loopback (browser) OAuth sign-in for subscription providers.
 *
 * Host-neutral Node: binds a local HTTP server on the provider's registered
 * callback port(s), opens the consent URL via an injected `openBrowser`, and
 * waits for the redirect to deliver the authorization code.
 *
 * Worked exemplar for the Effect 4 runtime PRD
 * (`docs/prds/2026-08-26-effect-4-runtime-migration.md`): the server is a
 * scoped resource, the callback wait is a `Deferred` under a timeout, and
 * cancellation is fiber interruption delivered from the caller's
 * `AbortSignal` at the single run boundary in {@link loginWithOAuthLoopback}.
 * The exported Promise API, error identities, and HTTP responses are
 * unchanged.
 */
import http from 'node:http';

import { Cause, Deferred, Duration, Effect, Exit } from 'effect';

import { AUTH_CALLBACK_TIMEOUT_MS } from '../config';
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

/** Minimal coordinator surface the loopback flow needs. */
export interface LoopbackOAuthCoordinator<S> {
  buildAuthorizeRequest(port: number): SubscriptionAuthorizeRequest;
  completeLoginWithCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<S>;
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
  signal?: AbortSignal;
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

function loginProgram<S>(options: OAuthLoopbackLoginOptions<S>) {
  const { coordinator, openBrowser, ports, callbackPath, displayName } =
    options;
  // The setup prefix is uninterruptible to preserve the Promise
  // implementation's observable ordering: it bound the server, armed the
  // callback wait, and invoked `openBrowser` before its first cancellation
  // check, so a launcher that never settles must still be started and an
  // abort must still settle the login. Interruption is observed from the
  // launcher await onward — the same points the old code raced against its
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
        try {
          const url = new URL(req.url ?? '', `http://127.0.0.1:${port}`);
          if (url.pathname !== callbackPath) {
            res.statusCode = 404;
            res.end('Not found');
            return;
          }
          // A stale or foreign callback answers with the error page but keeps
          // the wait open; only a state-matched callback settles it.
          if (url.searchParams.get('state') !== authorize.state) {
            respondHtml(res, ERROR_HTML, 400);
            return;
          }
          const oauthError = url.searchParams.get('error');
          if (oauthError) {
            respondHtml(res, ERROR_HTML, 400);
            Deferred.doneUnsafe(
              code,
              Effect.fail(
                new Error(`${displayName} sign-in failed: ${oauthError}`),
              ),
            );
            return;
          }
          const authCode = url.searchParams.get('code');
          if (!authCode) {
            respondHtml(res, ERROR_HTML, 400);
            return;
          }
          respondHtml(res, successHtml(displayName));
          Deferred.doneUnsafe(code, Effect.succeed(authCode));
        } catch (error) {
          res.statusCode = 500;
          res.end('Internal error');
          Deferred.doneUnsafe(code, Effect.fail(error as Error));
        }
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => server.on('request', onRequest)),
        () =>
          Effect.sync(() => {
            server.off('request', onRequest);
          }),
      );

      const browserLaunch = Promise.resolve(openBrowser(authorize.url));
      // A launch failure that loses to cancellation is abandoned, as before;
      // keep its late rejection observed.
      void browserLaunch.catch(() => {});
      return { authorize, code, browserLaunch };
    }),
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const { authorize, code, browserLaunch } = yield* setup;

      yield* Effect.tryPromise({
        try: () => browserLaunch,
        catch: (error) => error,
      });

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

      return yield* Effect.tryPromise({
        try: () =>
          coordinator.completeLoginWithCode({
            code: authCode,
            verifier: authorize.verifier,
            redirectUri: authorize.redirectUri,
          }),
        catch: (error) => error,
      });
    }),
  );
}

/**
 * Run the loopback sign-in flow end to end and persist the session via the
 * coordinator.
 */
export async function loginWithOAuthLoopback<S>(
  options: OAuthLoopbackLoginOptions<S>,
): Promise<S> {
  const { signal } = options;
  signal?.throwIfAborted();
  let exit: Exit.Exit<S, unknown>;
  try {
    exit = await Effect.runPromiseExit(loginProgram(options), { signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
  if (Exit.isSuccess(exit)) return exit.value;
  if (signal?.aborted) throw signal.reason;
  throw Cause.squash(exit.cause);
}
