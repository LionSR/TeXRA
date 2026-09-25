// The CLI's callback transport: a loopback HTTP server held open for one
// sign-in attempt.
//
// Protocol only. The nonce check, the pending record, the PKCE bind and the
// session commit are the shared `SupabaseSignInCoordinator`'s; this file
// carries the browser round trip and the pages the user sees. The served page
// scrubs the one-time `?code=` out of the browser's address bar and history
// before posting the query back, which is why the callback arrives as a POST
// rather than being read straight off the GET.

// Node imports
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

// Third-party imports
import { Cause, Effect, Result } from 'effect';
import { z } from 'zod';

// Local imports
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { withCallbackNonce } from '@controllers/auth/pendingOAuthStore';
import type {
  AuthCallbackRoute,
  AuthCallbackTransport,
  SignInCallbackOutcome,
} from '@controllers/auth/supabaseSignIn';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import { escapeHtml } from '@shared/utils/xmlEscape';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/auth-callback';
const MAX_CALLBACK_BODY_BYTES = 8 * 1024;

/** How the CLI shows the consent URL and reports an unattended callback. */
interface LoopbackTransportOptions {
  /** The process runtime each inbound request's program is forked on. */
  readonly runtime: ProcessRuntime;
  /** Launch the browser; `false` prints the URL and waits. */
  readonly openBrowser: (url: string) => Effect.Effect<void, Error>;
}

/**
 * The loopback transport. `open` is scoped: the server is closed when the
 * attempt's scope retires, on success, failure and cancellation alike.
 */
export function loopbackCallbackTransport(
  options: LoopbackTransportOptions,
): AuthCallbackTransport {
  return {
    open: (route) =>
      Effect.map(
        Effect.acquireRelease(
          startLoopbackServer(options.runtime, route),
          ({ server }) => Effect.orDie(closeServer(server)),
        ),
        ({ port }) =>
          withCallbackNonce(
            `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`,
            route.nonce,
          ),
      ),
    presentSignInUrl: (url) => options.openBrowser(url),
    // The loopback route exists only for the life of one attempt, so an
    // outcome with nothing waiting on it belongs to an attempt the terminal
    // already abandoned; the browser page carries the wording the user needs.
    announce: (outcome) =>
      Effect.logWarning(
        `Loopback sign-in callback ${outcome.kind} with no attempt waiting.`,
      ).pipe(withLogChannel('cli-auth')),
  };
}

const startLoopbackServer = Effect.fn(
  'supabaseAuthCallbackServer.startLoopbackServer',
)(function* (runtime: ProcessRuntime, route: AuthCallbackRoute) {
  const server = createServer((request, response) => {
    // Node's http callback is the foreign edge: each request's program is
    // forked on the process runtime, and every outcome — including a defect —
    // is folded into the response by the program itself.
    runtime.runFork(handleCallbackRequest(request, response, route));
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
  return { server, port: address.port };
});

const handleCallbackRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  route: AuthCallbackRoute,
): Effect.Effect<void, never, ProcessServices> =>
  Effect.gen(function* () {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (request.method === 'GET' && url.pathname === CALLBACK_PATH) {
      writeHtml(response, 200, callbackHtml());
      return;
    }
    if (
      request.method !== 'POST' ||
      url.pathname !== `${CALLBACK_PATH}/complete`
    ) {
      writeHtml(
        response,
        404,
        failureHtml('Unknown authentication callback path.'),
      );
      return;
    }

    const parsed = parseJsonWith(
      yield* readRequestBody(request),
      CallbackBodySchema,
    );
    if (Result.isFailure(parsed)) {
      writeHtml(
        response,
        400,
        failureHtml('Authentication callback request was malformed.'),
      );
      return;
    }

    const query = parsed.success.query ?? '';
    const outcome = yield* route.accept({
      path: CALLBACK_PATH,
      query: query.startsWith('?') ? query.slice(1) : query,
    });
    writeOutcome(response, outcome);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        writeHtml(
          response,
          400,
          failureHtml(toErrorMessage(Cause.squash(cause))),
        );
      }),
    ),
  );

function writeOutcome(
  response: ServerResponse,
  outcome: SignInCallbackOutcome,
): void {
  if (outcome.kind === 'committed') {
    writeHtml(response, 200, successHtml(outcome.session.account.label));
    return;
  }
  writeHtml(
    response,
    400,
    failureHtml(
      outcome.kind === 'failed'
        ? outcome.message
        : `this callback did not match the sign-in in progress (${outcome.reason}).`,
    ),
  );
}

function readRequestBody(
  request: IncomingMessage,
): Effect.Effect<string, Error> {
  return Effect.callback((resume) => {
    let body = '';
    let bodyBytes = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      bodyBytes += Buffer.byteLength(chunk, 'utf8');
      if (bodyBytes > MAX_CALLBACK_BODY_BYTES) {
        resume(
          Effect.fail(
            new Error('Authentication callback request body is too large.'),
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
          new Error(
            `Authentication callback request failed: ${ensureError(error).message}`,
          ),
        ),
      );
    });
  });
}

/**
 * The loopback callback body we accept. A non-object body is rejected; a
 * present-but-non-string field degrades to `undefined` (the `z.preprocess`
 * per-field policy), written without `.catch` so this `effect`-importing
 * file keeps no raw catch.
 */
const CallbackBodySchema = z.object({
  query: z.preprocess(
    (value) => (typeof value === 'string' ? value : undefined),
    z.string().nullish(),
  ),
});

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

function callbackHtml(): string {
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
      body: JSON.stringify({ query: callbackQuery })
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

function closeServer(server: Server): Effect.Effect<void, Error> {
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
