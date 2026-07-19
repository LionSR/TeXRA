/**
 * Loopback (browser) sign-in for Codex OAuth.
 *
 * Host-neutral Node: binds a local HTTP server on the FIXED port the borrowed
 * client id allows (1455, fallback 1457 — no other port works), opens the
 * consent URL via an injected `openBrowser`, and waits for the redirect to
 * deliver the authorization code. The host supplies only browser-open; nothing
 * here imports `vscode`.
 */
import http from 'node:http';

import {
  CODEX_CALLBACK_FALLBACK_PORT,
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORT,
} from './codexConstants';
import { type CodexSessionCoordinator } from './CodexSessionCoordinator';
import { type CodexSession } from './codexSessionTypes';

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title></head>
<body style="font-family:system-ui;text-align:center;padding-top:4rem">
<h2>Signed in with ChatGPT</h2>
<p>You can close this tab and return to TeXRA.</p>
</body></html>`;

const ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in error</title></head>
<body style="font-family:system-ui;text-align:center;padding-top:4rem">
<h2>Sign-in error</h2>
<p>Return to TeXRA and try signing in again.</p>
</body></html>`;

export interface CodexLoopbackLoginOptions {
  coordinator: CodexSessionCoordinator;
  /** Open the consent URL in the user's browser. */
  openBrowser: (url: string) => void | Promise<void>;
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

async function bindLoopbackServer(): Promise<{
  server: http.Server;
  port: number;
}> {
  for (const port of [CODEX_CALLBACK_PORT, CODEX_CALLBACK_FALLBACK_PORT]) {
    const server = http.createServer();
    const bound = await new Promise<boolean>((resolve) => {
      const onError = () => {
        server.removeListener('listening', onListening);
        resolve(false);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (bound) return { server, port };
    server.close();
  }
  throw new Error(
    'Could not bind the ChatGPT sign-in callback on port 1455 or 1457. ' +
      'Close whatever is using them, or use device-code sign-in instead.',
  );
}

/**
 * Run the loopback sign-in flow end to end and persist the session. Resolves to
 * the stored session on success; rejects on state mismatch, OAuth error,
 * timeout, or token exchange failure.
 */
export async function loginWithLoopback(
  options: CodexLoopbackLoginOptions,
): Promise<CodexSession> {
  const { coordinator, openBrowser, signal } = options;
  const { server, port } = await bindLoopbackServer();
  const authorize = coordinator.buildAuthorizeRequest(port);
  let callbackTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    signal?.throwIfAborted();
    abortListener = () => reject(signal?.reason);
    signal?.addEventListener('abort', abortListener, { once: true });
  });
  void cancellationPromise.catch(() => {
    // The operation raced against cancellation may still be resolving.
  });

  const codePromise = new Promise<string>((resolve, reject) => {
    callbackTimer = setTimeout(() => {
      reject(new Error('Timed out waiting for the ChatGPT sign-in callback.'));
    }, CALLBACK_TIMEOUT_MS);

    const rejectCallback = (
      res: http.ServerResponse,
      message: string,
      statusCode = 400,
    ) => {
      respondHtml(res, ERROR_HTML, statusCode);
      clearTimeout(callbackTimer);
      reject(new Error(message));
    };

    const ignoreCallback = (res: http.ServerResponse, statusCode = 400) => {
      respondHtml(res, ERROR_HTML, statusCode);
    };

    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url ?? '', `http://127.0.0.1:${port}`);
        if (url.pathname !== CODEX_CALLBACK_PATH) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        if (url.searchParams.get('state') !== authorize.state) {
          ignoreCallback(res);
          return;
        }
        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          rejectCallback(res, `ChatGPT sign-in failed: ${oauthError}`);
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          ignoreCallback(res);
          return;
        }
        respondHtml(res, SUCCESS_HTML);
        clearTimeout(callbackTimer);
        resolve(code);
      } catch (error) {
        res.statusCode = 500;
        res.end('Internal error');
        clearTimeout(callbackTimer);
        reject(error as Error);
      }
    });
  });

  try {
    await Promise.race([
      Promise.resolve(openBrowser(authorize.url)),
      cancellationPromise,
    ]);
    const code = await Promise.race([codePromise, cancellationPromise]);
    signal?.throwIfAborted();
    if (abortListener) {
      signal?.removeEventListener('abort', abortListener);
      abortListener = undefined;
    }
    return await coordinator.completeLoginWithCode({
      code,
      verifier: authorize.verifier,
      redirectUri: authorize.redirectUri,
    });
  } finally {
    clearTimeout(callbackTimer);
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    server.close();
  }
}
