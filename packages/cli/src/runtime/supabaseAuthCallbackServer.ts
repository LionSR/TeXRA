// Standard library imports
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import pDefer from 'p-defer';
import { z } from 'zod';

// Local imports - auth
import { AUTH_CALLBACK_TIMEOUT_MS } from '@auth/config';
import {
  type SupabaseSession,
  type SupabaseSessionCoordinator,
} from '@auth/SupabaseSession';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { escapeHtml } from '@shared/utils/xmlEscape';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

export interface LoopbackCallbackServer {
  readonly redirectTo: string;
  waitForSession(signal?: AbortSignal): Promise<SupabaseSession>;
  close(): Promise<void>;
}

export async function startLoopbackCallbackServer(
  authCoordinator: SupabaseSessionCoordinator,
): Promise<LoopbackCallbackServer> {
  const nonce = randomBytes(CALLBACK_NONCE_BYTES).toString('base64url');
  const {
    promise: sessionPromise,
    resolve: resolveSession,
    reject: rejectSession,
  } = pDefer<SupabaseSession>();
  const attemptState: CallbackAttemptState = {
    acceptingCallbacks: true,
    commitStarted: false,
  };

  const server = createServer((request, response) => {
    void handleCallbackRequest(
      request,
      response,
      authCoordinator,
      nonce,
      attemptState,
    )
      .then((session) => {
        if (session) resolveSession(session);
      })
      .catch((error: unknown) => {
        const recoverable = error instanceof RecoverableCallbackRequestError;
        const message = toErrorMessage(error);
        if (!recoverable) {
          rejectSession(error instanceof Error ? error : new Error(message));
        }
        writeHtml(response, recoverable ? 400 : 500, failureHtml(message));
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Could not start CLI authentication callback server.');
  }

  const timeout = setTimeout(() => {
    rejectSession(new Error('Authentication timed out. Try again.'));
  }, AUTH_CALLBACK_TIMEOUT_MS);
  const cleanup = (): void => {
    clearTimeout(timeout);
  };
  sessionPromise.catch(() => {
    // Prevent unhandled rejections if OAuth setup fails before callers wait.
  });

  return {
    redirectTo: `http://${LOOPBACK_HOST}:${address.port}${CALLBACK_PATH}`,
    waitForSession: (signal) => {
      if (!signal) return sessionPromise.finally(cleanup);
      signal.throwIfAborted();
      const onAbort = (): void => {
        if (attemptState.commitStarted) return;
        attemptState.acceptingCallbacks = false;
        rejectSession(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      return sessionPromise.finally(() => {
        signal.removeEventListener('abort', onAbort);
        cleanup();
      });
    },
    close: async () => {
      cleanup();
      await closeServer(server);
    },
  };
}

function assertAcceptingCallbacks(attemptState: CallbackAttemptState): void {
  if (!attemptState.acceptingCallbacks) {
    throw new RecoverableCallbackRequestError(
      'This authentication attempt was cancelled.',
    );
  }
}

async function handleCallbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authCoordinator: SupabaseSessionCoordinator,
  nonce: string,
  attemptState: CallbackAttemptState,
): Promise<SupabaseSession | undefined> {
  assertAcceptingCallbacks(attemptState);
  const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
  if (request.method === 'GET' && url.pathname === CALLBACK_PATH) {
    writeHtml(response, 200, callbackHtml(nonce));
    return undefined;
  }

  if (
    request.method === 'POST' &&
    url.pathname === `${CALLBACK_PATH}/complete`
  ) {
    const body = parseCallbackBody(await readRequestBody(request));
    if (body.nonce !== nonce) {
      throw new RecoverableCallbackRequestError(
        'Authentication callback did not match this login attempt.',
      );
    }
    assertAcceptingCallbacks(attemptState);
    const result = await authCoordinator.createSessionFromCallback({
      path: CALLBACK_PATH,
      query: body.query?.startsWith('?')
        ? body.query.slice(1)
        : (body.query ?? ''),
    });
    if (!result.success) throw new Error(result.error);
    assertAcceptingCallbacks(attemptState);

    attemptState.commitStarted = true;
    attemptState.acceptingCallbacks = false;
    await authCoordinator.storeSession(result.session);
    writeHtml(response, 200, successHtml(result.session.account.label));
    return result.session;
  }

  writeHtml(
    response,
    404,
    failureHtml('Unknown authentication callback path.'),
  );
  return undefined;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bodyBytes = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      bodyBytes += Buffer.byteLength(chunk, 'utf8');
      if (bodyBytes > MAX_CALLBACK_BODY_BYTES) {
        reject(
          new RecoverableCallbackRequestError(
            'Authentication callback request body is too large.',
          ),
        );
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', (error) => {
      reject(
        new RecoverableCallbackRequestError(
          `Authentication callback request failed: ${error.message}`,
        ),
      );
    });
  });
}

/**
 * The loopback callback body we accept. A non-object body is rejected; a
 * present-but-non-string field degrades to `undefined` (per-field `.catch`),
 * matching the previous manual `typeof === 'string'` guards.
 */
const CallbackBodySchema = z.object({
  query: z.string().nullish().catch(undefined),
  nonce: z.string().nullish().catch(undefined),
});

function parseCallbackBody(
  rawBody: string,
): z.infer<typeof CallbackBodySchema> {
  const parsed = parseJsonWith(rawBody, CallbackBodySchema);
  if (parsed.isErr()) {
    throw new RecoverableCallbackRequestError(
      'Authentication callback request was malformed.',
    );
  }
  return parsed.value;
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

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
