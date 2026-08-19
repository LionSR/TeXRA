/**
 * Parameterized loopback (browser) OAuth sign-in for subscription providers.
 *
 * Host-neutral Node: binds a local HTTP server on the provider's registered
 * callback port(s), opens the consent URL via an injected `openBrowser`, and
 * waits for the redirect to deliver the authorization code.
 */
import http from 'node:http';

import { AUTH_CALLBACK_TIMEOUT_MS } from '../config';

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

interface LoopbackAuthorizeRequest {
  url: string;
  verifier: string;
  state: string;
  redirectUri: string;
}

/** Minimal coordinator surface the loopback flow needs. */
export interface LoopbackOAuthCoordinator<S> {
  buildAuthorizeRequest(port: number): LoopbackAuthorizeRequest;
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

async function bindLoopbackServer(
  ports: readonly number[],
  displayName: string,
): Promise<{ server: http.Server; port: number }> {
  for (const port of ports) {
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
  const portList = ports.join(' or ');
  throw new LoopbackTransportUnavailableError(
    `Could not bind the ${displayName} sign-in callback on port ${portList}. ` +
      'Close whatever is using them, or use device-code sign-in instead.',
  );
}

/**
 * Run the loopback sign-in flow end to end and persist the session via the
 * coordinator.
 */
export async function loginWithOAuthLoopback<S>(
  options: OAuthLoopbackLoginOptions<S>,
): Promise<S> {
  const { coordinator, openBrowser, ports, callbackPath, displayName, signal } =
    options;
  const { server, port } = await bindLoopbackServer(ports, displayName);
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
      reject(
        new Error(`Timed out waiting for the ${displayName} sign-in callback.`),
      );
    }, AUTH_CALLBACK_TIMEOUT_MS);

    const rejectCallback = (
      res: http.ServerResponse,
      message: string,
      statusCode = 400,
    ) => {
      respondHtml(res, ERROR_HTML, statusCode);
      clearTimeout(callbackTimer);
      reject(new Error(message));
    };

    const ignoreCallback = (res: http.ServerResponse) => {
      respondHtml(res, ERROR_HTML, 400);
    };

    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url ?? '', `http://127.0.0.1:${port}`);
        if (url.pathname !== callbackPath) {
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
          rejectCallback(res, `${displayName} sign-in failed: ${oauthError}`);
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          ignoreCallback(res);
          return;
        }
        respondHtml(res, successHtml(displayName));
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
    // The abort listener stays attached until the `finally` below: after the
    // race settles, a late abort only rejects the already-settled
    // cancellationPromise (swallowed above), so no early removal is needed.
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
