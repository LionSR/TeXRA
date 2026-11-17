/**
 * Parameterized loopback (browser) OAuth sign-in for subscription providers.
 *
 * Host-neutral Node: binds a local HTTP server on the provider's registered
 * callback port(s), opens the consent URL via an injected `openBrowser`, and
 * waits for the redirect to deliver the authorization code.
 *
 * The server is a scoped resource, the callback wait is a `Deferred` under a timeout, and
 * cancellation is fiber interruption, delivered by the host that runs the
 * program at its own edge. Error identities and HTTP responses are unchanged.
 */
import http from 'node:http';

import { Deferred, Duration, Effect, Result, Schema } from 'effect';
import type { HttpClient } from 'effect/http';

import { toErrorMessage } from '../errors.js';

import type {
  SubscriptionAuthorizeRequest,
  SubscriptionCallback,
  SubscriptionOAuthPolicy,
} from './subscriptionCoordinator.js';

/**
 * How long an interactive browser sign-in may take before the host stops
 * waiting for the callback (10 minutes). Generous on purpose: an OAuth
 * round-trip with 2FA and account switching outlasts a couple of minutes, and
 * each flow is user-cancellable, so a long deadline only delays the failure
 * message for attempts nobody is waiting on.
 *
 * Device-code flows do not use this: RFC 8628 makes the server's `expires_in`
 * authoritative there.
 */
const AUTH_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The loopback route could never be established — the registered callback
 * port(s) could not be bound, or the host could not reach a browser at all.
 * Distinct from every other sign-in failure because nothing was asked of the
 * user yet: a host with a device-code transport can retry on that instead.
 */
export class LoopbackTransportUnavailableError extends Schema.TaggedError<LoopbackTransportUnavailableError>()(
  'LoopbackTransportUnavailableError',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** The browser sign-in was started and delivered no usable code: the
 *  provider reported an error, the callback could not be read, or none
 *  arrived in time. */
class LoopbackSignInFailed extends Schema.TaggedError<LoopbackSignInFailed>()(
  'LoopbackSignInFailed',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** What one browser sign-in runs: the provider's registered callback, the
 *  account's two protocol steps, and the host's presentation. */
interface LoopbackLoginOptions<S> {
  readonly loopback: SubscriptionOAuthPolicy<never>['loopback'];
  /** The PKCE authorize request for a callback on `port`. */
  readonly authorize: (
    port: number,
  ) => Effect.Effect<SubscriptionAuthorizeRequest, Error>;
  /**
   * Exchange the callback's code and store the session. A program, so it
   * runs on this flow's own fiber: interrupting the sign-in reaches the
   * token exchange and the session store.
   */
  readonly exchange: (
    request: SubscriptionAuthorizeRequest,
    callback: SubscriptionCallback,
  ) => Effect.Effect<S, Error, HttpClient.HttpClient>;
  /**
   * Show (and normally open) the consent URL. A program, so the host's own
   * presentation runs on this flow's fibers and its failure — typically a
   * {@link LoopbackTransportUnavailableError} — reaches the caller through
   * the error channel instead of a rejection this flow has to re-wrap.
   */
  readonly openBrowser: (url: string) => Effect.Effect<void, Error>;
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

/** One bind attempt; succeeds with undefined when the port is unavailable.
 *  Port 0 asks the system for a free one. */
function listenAttempt(port: number): Effect.Effect<http.Server | undefined> {
  // Non-failing: the registration below resumes on `listening` or on `error`,
  // and `listen` reports a bind failure through that `error` listener rather
  // than throwing (every caller passes a fixed, in-range port or 0).
  return Effect.callback<http.Server | undefined>((resume) => {
    const server = http.createServer();
    const onError = () => {
      server.removeListener('listening', onListening);
      server.close();
      resume(Effect.undefined);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resume(Effect.succeed(server));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

const bindLoopbackServer = Effect.fnUntraced(function* (
  ports: readonly number[],
  displayName: string,
): Effect.fn.Return<
  { server: http.Server; port: number },
  LoopbackTransportUnavailableError
> {
  for (const port of ports) {
    const server = yield* listenAttempt(port);
    const address = server?.address();
    if (server && address !== null && typeof address === 'object')
      return { server, port: address.port };
  }
  const portList = ports.join(' or ');
  return yield* new LoopbackTransportUnavailableError({
    message:
      `Could not bind the ${displayName} sign-in callback on port ${portList}. ` +
      'Close whatever is using them, or use device-code sign-in instead.',
  });
});

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
  | {
      readonly kind: 'code';
      readonly code: string;
      /** The client a registering provider issued, when the callback names one. */
      readonly clientId: string | undefined;
    };

function decideCallback(
  rawUrl: string | undefined,
  base: string,
  callbackPath: string,
  expectedState: string,
): Result.Result<CallbackDecision, LoopbackSignInFailed> {
  return Result.try({
    try: (): CallbackDecision => {
      const url = new URL(rawUrl ?? '', base);
      if (url.pathname !== callbackPath) {
        return { kind: 'not-found' };
      }
      // A stale or foreign callback answers with the error page but keeps
      // the wait open; only a state-matched callback finishes it.
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
      return {
        kind: 'code',
        code: authCode,
        clientId: url.searchParams.get('client_id') ?? undefined,
      };
    },
    catch: (cause) =>
      new LoopbackSignInFailed({
        message: `Unreadable OAuth callback URL: ${toErrorMessage(cause)}`,
        cause,
      }),
  });
}

/**
 * The loopback sign-in flow end to end: bind, open the browser, wait for the
 * callback, and exchange its code.
 */
export function loginWithLoopback<S>(
  options: LoopbackLoginOptions<S>,
): Effect.Effect<S, Error, HttpClient.HttpClient> {
  const { authorize, exchange, openBrowser, loopback } = options;
  const { ports, callbackPath, displayName } = loopback;
  // Everything the sign-in starts lives in its scope: the server, the
  // callback handler and the browser launcher, so interrupting the sign-in
  // closes the presenter with it, and a launch failure is the sign-in's.
  return Effect.scoped(
    Effect.gen(function* () {
      const { server, port } = yield* Effect.acquireRelease(
        bindLoopbackServer(ports, displayName),
        (bound) =>
          Effect.sync(() => {
            bound.server.close();
          }),
      );
      const request = yield* authorize(port);
      const code = yield* Deferred.make<
        SubscriptionCallback,
        LoopbackSignInFailed
      >();

      const onRequest = (
        req: http.IncomingMessage,
        res: http.ServerResponse,
      ): void => {
        const decision = decideCallback(
          req.url,
          `http://127.0.0.1:${port}`,
          callbackPath,
          request.state,
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
                new LoopbackSignInFailed({
                  message: `${displayName} sign-in failed: ${decision.success.error}`,
                }),
              ),
            );
            return;
          case 'code':
            respondHtml(res, successHtml(displayName));
            Deferred.doneUnsafe(
              code,
              Effect.succeed({
                code: decision.success.code,
                clientId: decision.success.clientId,
              }),
            );
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

      // The launch is awaited before the callback wait opens: a host that
      // cannot reach a browser fails fast instead of leaving the flow
      // waiting for a callback nobody can deliver.
      yield* openBrowser(request.url);

      const callback = yield* Deferred.await(code).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(AUTH_CALLBACK_TIMEOUT_MS),
          orElse: () =>
            Effect.fail(
              new LoopbackSignInFailed({
                message: `Timed out waiting for the ${displayName} sign-in callback.`,
              }),
            ),
        }),
      );

      return yield* exchange(request, callback);
    }),
  );
}
