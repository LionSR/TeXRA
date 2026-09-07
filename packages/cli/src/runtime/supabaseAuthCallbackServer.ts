// Standard library imports
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { z } from 'zod';

// Local imports - auth
import { Cause, Deferred, Effect, Exit, Result, Scope } from 'effect';
import { unwrapAuthPortCause } from '@auth/authProgram';
import { AUTH_CALLBACK_TIMEOUT_MS } from '@auth/config';
import {
  type SupabaseSession,
  type SupabaseSessionCoordinator,
} from '@auth/SupabaseSession';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { effectRuntime } from '@platform/processRuntime';
import { escapeHtml } from '@shared/utils/xmlEscape';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/auth-callback';
const CALLBACK_NONCE_BYTES = 24;
const MAX_CALLBACK_BODY_BYTES = 8 * 1024;

interface CallbackAttemptState {
  acceptingCallbacks: boolean;
  commitStarted: boolean;
}

class RecoverableCallbackRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoverableCallbackRequestError';
  }
}

/**
 * The loopback server's surface is Effect-typed (PRD R1): the sign-in
 * program composes the waits and the close, and its host entry's run edge
 * turns a cancellation signal into fiber interruption.
 */
export interface LoopbackCallbackServer {
  readonly redirectTo: string;
  /** Whether the storage commit has begun. A cancellation that lands after
   *  this point still settles the sign-in: v4 fiber interruption is sticky
   *  (once delivered it re-fires at every interruptible boundary, so the
   *  wait cannot recover in-runtime), and the Promise edge re-awaits the
   *  session on a fresh fiber instead. */
  readonly commitStarted: boolean;
  /** Settles (success or failure) exactly when the login attempt does, with
   *  no cancellation side effects — the branch to race a browser launch
   *  against, since the race's loser is interrupted. */
  readonly sessionSettled: Effect.Effect<void, Error>;
  /** Await the completed session: the OAuth callback, a callback failure, or
   *  the login-attempt timeout. Interruption is the caller cancelling the
   *  login; `cancel` is what refuses further callbacks. */
  readonly waitForSession: Effect.Effect<SupabaseSession, Error>;
  /** Refuse further callbacks unless a commit is already underway. */
  readonly cancel: Effect.Effect<void>;
  readonly close: Effect.Effect<void, Error>;
}

export const startLoopbackCallbackServer = Effect.fn(
  'supabaseAuthCallbackServer.startLoopbackCallbackServer',
)(function* (authCoordinator: SupabaseSessionCoordinator) {
  const nonce = randomBytes(CALLBACK_NONCE_BYTES).toString('base64url');
  const sessionDeferred = yield* Deferred.make<SupabaseSession, Error>();
  const attemptState: CallbackAttemptState = {
    acceptingCallbacks: true,
    commitStarted: false,
  };
  const refuseFurtherCallbacks = (): void => {
    if (!attemptState.commitStarted) attemptState.acceptingCallbacks = false;
  };

  const server = createServer((request, response) => {
    // Node's http callback is the foreign edge: each request's program is
    // forked on the process runtime, and every outcome — success, typed
    // failure, or defect — is folded into the response and the deferred by
    // the program itself.
    effectRuntime().runFork(
      handleCallbackRequest(
        request,
        response,
        authCoordinator,
        nonce,
        attemptState,
      ).pipe(
        Effect.matchCause({
          onFailure: (cause) => {
            const error = Cause.squash(cause);
            const recoverable =
              error instanceof RecoverableCallbackRequestError;
            if (!recoverable) {
              Deferred.doneUnsafe(
                sessionDeferred,
                Effect.fail(ensureError(error)),
              );
            }
            writeHtml(
              response,
              recoverable ? 400 : 500,
              failureHtml(toErrorMessage(error)),
            );
          },
          onSuccess: (session) => {
            if (session) {
              Deferred.doneUnsafe(sessionDeferred, Effect.succeed(session));
            }
          },
        }),
      ),
    );
  });

  yield* Effect.callback<void, Error>((resume) => {
    const onError = (error: Error): void => resume(Effect.fail(error));
    server.once('error', onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', onError);
      resume(Effect.void);
    });
    return Effect.sync(() => {
      server.close();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    yield* closeServer(server);
    return yield* Effect.fail(
      new Error('Could not start CLI authentication callback server.'),
    );
  }

  // The login-attempt timeout is a fiber in this scope, so `close` retiring
  // the scope is the `clearTimeout` the p-defer version ran on cleanup.
  const scope = yield* Scope.make();
  yield* Effect.forkIn(
    Effect.andThen(
      Effect.sleep(AUTH_CALLBACK_TIMEOUT_MS),
      Deferred.fail(
        sessionDeferred,
        new Error('Authentication timed out. Try again.'),
      ),
    ),
    scope,
  );

  return {
    redirectTo: `http://${LOOPBACK_HOST}:${address.port}${CALLBACK_PATH}`,
    get commitStarted() {
      return attemptState.commitStarted;
    },
    sessionSettled: Deferred.await(sessionDeferred).pipe(Effect.asVoid),
    waitForSession: Deferred.await(sessionDeferred),
    cancel: Effect.sync(refuseFurtherCallbacks),
    close: Effect.andThen(Scope.close(scope, Exit.void), closeServer(server)),
  };
});

const assertAcceptingCallbacks = (
  attemptState: CallbackAttemptState,
): Effect.Effect<void, RecoverableCallbackRequestError> =>
  attemptState.acceptingCallbacks
    ? Effect.void
    : Effect.fail(
        new RecoverableCallbackRequestError(
          'This authentication attempt was cancelled.',
        ),
      );

const handleCallbackRequest = Effect.fn(
  'supabaseAuthCallbackServer.handleCallbackRequest',
)(function* (
  request: IncomingMessage,
  response: ServerResponse,
  authCoordinator: SupabaseSessionCoordinator,
  nonce: string,
  attemptState: CallbackAttemptState,
) {
  yield* assertAcceptingCallbacks(attemptState);
  const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
  if (request.method === 'GET' && url.pathname === CALLBACK_PATH) {
    writeHtml(response, 200, callbackHtml(nonce));
    return undefined;
  }

  if (
    request.method === 'POST' &&
    url.pathname === `${CALLBACK_PATH}/complete`
  ) {
    const body = yield* parseCallbackBody(yield* readRequestBody(request));
    if (body.nonce !== nonce) {
      return yield* Effect.fail(
        new RecoverableCallbackRequestError(
          'Authentication callback did not match this login attempt.',
        ),
      );
    }
    yield* assertAcceptingCallbacks(attemptState);
    const result = yield* authCoordinator
      .createSessionFromCallback({
        path: CALLBACK_PATH,
        query: body.query?.startsWith('?')
          ? body.query.slice(1)
          : (body.query ?? ''),
      })
      .pipe(Effect.mapError(unwrapAuthPortCause));
    if (!result.success) return yield* Effect.fail(new Error(result.error));
    yield* assertAcceptingCallbacks(attemptState);

    attemptState.commitStarted = true;
    attemptState.acceptingCallbacks = false;
    yield* authCoordinator
      .storeSession(result.session)
      .pipe(Effect.mapError(unwrapAuthPortCause));
    writeHtml(response, 200, successHtml(result.session.account.label));
    return result.session;
  }

  writeHtml(
    response,
    404,
    failureHtml('Unknown authentication callback path.'),
  );
  return undefined;
});

function readRequestBody(
  request: IncomingMessage,
): Effect.Effect<string, RecoverableCallbackRequestError> {
  return Effect.callback((resume) => {
    let body = '';
    let bodyBytes = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      bodyBytes += Buffer.byteLength(chunk, 'utf8');
      if (bodyBytes > MAX_CALLBACK_BODY_BYTES) {
        resume(
          Effect.fail(
            new RecoverableCallbackRequestError(
              'Authentication callback request body is too large.',
            ),
          ),
        );
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => resume(Effect.succeed(body)));
    request.on('error', (error) => {
      resume(
        Effect.fail(
          new RecoverableCallbackRequestError(
            `Authentication callback request failed: ${error.message}`,
          ),
        ),
      );
    });
  });
}

/**
 * The loopback callback body we accept. A non-object body is rejected; a
 * present-but-non-string field degrades to `undefined` (the `z.preprocess`
 * per-field policy, matching the previous manual `typeof === 'string'`
 * guards), written without `.catch` so this file stays at zero raw catches
 * (catch:effect-importer ratchet row).
 */
const CallbackBodySchema = z.object({
  query: z.preprocess(
    (value) => (typeof value === 'string' ? value : undefined),
    z.string().nullish(),
  ),
  nonce: z.preprocess(
    (value) => (typeof value === 'string' ? value : undefined),
    z.string().nullish(),
  ),
});

function parseCallbackBody(
  rawBody: string,
): Effect.Effect<
  z.infer<typeof CallbackBodySchema>,
  RecoverableCallbackRequestError
> {
  const parsed = parseJsonWith(rawBody, CallbackBodySchema);
  return Result.isFailure(parsed)
    ? Effect.fail(
        new RecoverableCallbackRequestError(
          'Authentication callback request was malformed.',
        ),
      )
    : Effect.succeed(parsed.success);
}

function writeHtml(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
  });
  response.end(body);
}

function callbackHtml(nonce: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>TeXRA CLI sign-in</title>
<body>
  <p>Completing TeXRA CLI sign-in...</p>
  <script>
    const callbackQuery = window.location.search;
    window.history.replaceState(null, document.title, window.location.pathname);
    fetch('/auth-callback/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: callbackQuery,
        nonce: ${JSON.stringify(nonce)}
      })
    })
      .then((response) => response.text())
      .then((html) => { document.documentElement.innerHTML = html; })
      .catch((error) => {
        document.body.textContent = 'Sign-in failed: ' + error.message;
      });
  </script>
</body>`;
}

function successHtml(accountLabel: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>TeXRA CLI signed in</title>
<body>
  <p>Signed in as ${escapeHtml(accountLabel)}. You may close this window.</p>
</body>`;
}

function failureHtml(message: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>TeXRA CLI sign-in failed</title>
<body>
  <p>Sign-in failed: ${escapeHtml(message)}</p>
</body>`;
}

function closeServer(
  server: ReturnType<typeof createServer>,
): Effect.Effect<void, Error> {
  return Effect.callback((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close((error) => {
      resume(error ? Effect.fail(error) : Effect.void);
    });
  });
}
