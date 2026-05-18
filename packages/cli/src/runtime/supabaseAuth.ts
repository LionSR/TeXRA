// Standard library imports
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

// Local imports - auth
import { AUTH_CALLBACK_TIMEOUT_MS, DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { createHostAuthCoordinator } from '@auth/createHostAuthCoordinator';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  type SupabaseSession,
  type SupabaseSessionCoordinator,
} from '@auth/SupabaseSession';
import { type OAuthProvider } from '@auth/sharedConfig';
import { getServerSideKeyService } from '@auth/serverKeys';
import { toErrorMessage } from '@common/errors/errorMessage';

// Local imports - CLI runtime
import { getCliSecrets } from './cliSecrets';

// Type imports - platform
import type { LogBackend } from '@platform/interfaces/log';

const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/auth-callback';
const CALLBACK_NONCE_BYTES = 24;
const MAX_CALLBACK_BODY_BYTES = 8 * 1024;

class RecoverableCallbackRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoverableCallbackRequestError';
  }
}

export interface CliAuthProfile {
  authenticated: boolean;
  accountLabel?: string;
  tier?: string;
}

export interface CliLoginOptions {
  provider?: OAuthProvider;
  openBrowser?: boolean;
  selectAccount?: boolean;
  loginHint?: string;
  log?: LogBackend;
  onAuthUrl?: (url: string) => void;
  manualBrowserHint?: string;
}

let coordinator: SupabaseSessionCoordinator | undefined;
let activeAuthLog: LogBackend | undefined;
const deferredAuthLog: LogBackend = {
  initialize: (channel, isAgent) => activeAuthLog?.initialize(channel, isAgent),
  debug: (channel, message) => activeAuthLog?.debug(channel, message),
  info: (channel, message) => activeAuthLog?.info(channel, message),
  warn: (channel, message) => activeAuthLog?.warn(channel, message),
  error: (channel, message) => activeAuthLog?.error(channel, message),
};
const cliAuthProvider = {
  isAuthenticated: () => SupabaseClient.isAuthenticated(),
  getUserTier: () => SupabaseClient.getUserTier(),
  getAccessToken: () => SupabaseClient.getAccessToken(),
};

function getCliSupabaseAuthCoordinator(): SupabaseSessionCoordinator {
  initializeCliSupabaseAuth();
  return coordinator!;
}

export function initializeCliSupabaseAuth(log?: LogBackend): void {
  activeAuthLog = log ?? activeAuthLog;
  coordinator ??= createHostAuthCoordinator({
    secrets: getCliSecrets(),
    log: deferredAuthLog,
  });
}

export function getCliAuthProvider() {
  return cliAuthProvider;
}

export async function signInCliSupabase(
  options: CliLoginOptions = {},
): Promise<SupabaseSession> {
  const provider = options.provider ?? DEFAULT_OAUTH_PROVIDER;
  const authCoordinator = getCliSupabaseAuthCoordinator();
  const callbackServer = await startLoopbackCallbackServer(authCoordinator);
  const redirectTo = callbackServer.redirectTo;
  const queryParams = buildOAuthQueryParams(provider, options);

  try {
    if (options.selectAccount || options.loginHint) {
      await authCoordinator.clearSession();
    }
    const { data, error } =
      await SupabaseClient.getClient().auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          ...(queryParams && { queryParams }),
        },
      });
    if (error || !data.url) {
      throw new Error(
        `OAuth initialization failed: ${error?.message || 'missing auth URL'}`,
      );
    }

    options.onAuthUrl?.(data.url);
    if (options.openBrowser ?? true) {
      await openBrowser(
        data.url,
        options.log,
        options.manualBrowserHint ?? 'texra login --no-browser',
      );
    }

    const session = await callbackServer.waitForSession();
    getServerSideKeyService().clearAllCaches({ resetQuotaFlip: true });
    await getServerSideKeyService().setUseIncludedModelAccess(true);
    return session;
  } finally {
    await callbackServer.close();
  }
}

function buildOAuthQueryParams(
  provider: OAuthProvider,
  options: Pick<CliLoginOptions, 'selectAccount' | 'loginHint'>,
): Record<string, string> | undefined {
  const queryParams: Record<string, string> = {};
  if (options.loginHint) {
    queryParams[provider === 'github' ? 'login' : 'login_hint'] =
      options.loginHint;
  }
  if (options.selectAccount && provider === 'google') {
    queryParams.prompt = 'select_account';
  }
  return Object.keys(queryParams).length > 0 ? queryParams : undefined;
}

export async function signOutCliSupabase(): Promise<void> {
  const authCoordinator = getCliSupabaseAuthCoordinator();
  await authCoordinator.clearSession();
  const serverSideKeyService = getServerSideKeyService();
  await serverSideKeyService.setUseIncludedModelAccess(false);
  serverSideKeyService.clearAllCaches({ resetQuotaFlip: true });
}

export async function getCliAuthProfile(): Promise<CliAuthProfile> {
  initializeCliSupabaseAuth();
  const authenticated = await SupabaseClient.isAuthenticated();
  if (!authenticated) return { authenticated: false };

  const session = await getCliSupabaseAuthCoordinator().loadSession();
  let tier = 'free';
  try {
    tier = await SupabaseClient.getUserTier();
  } catch {
    // Keep status usable even if profile metadata is temporarily unavailable.
  }
  return {
    authenticated: true,
    accountLabel: session?.account.label,
    tier,
  };
}

async function startLoopbackCallbackServer(
  authCoordinator: SupabaseSessionCoordinator,
): Promise<{
  redirectTo: string;
  waitForSession: () => Promise<SupabaseSession>;
  close: () => Promise<void>;
}> {
  const nonce = randomBytes(CALLBACK_NONCE_BYTES).toString('base64url');
  let resolveSession: (session: SupabaseSession) => void = () => {};
  let rejectSession: (error: Error) => void = () => {};
  const sessionPromise = new Promise<SupabaseSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });

  const server = createServer((request, response) => {
    void handleCallbackRequest(request, response, authCoordinator, nonce)
      .then((session) => {
        if (session) resolveSession(session);
      })
      .catch((error: unknown) => {
        const message = toErrorMessage(error);
        if (!isRecoverableCallbackRequestError(error)) {
          rejectSession(error instanceof Error ? error : new Error(message));
        }
        writeHtml(
          response,
          isRecoverableCallbackRequestError(error) ? 400 : 500,
          failureHtml(message),
        );
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
    waitForSession: () =>
      sessionPromise.finally(() => {
        cleanup();
      }),
    close: async () => {
      cleanup();
      await closeServer(server);
    },
  };
}

async function handleCallbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authCoordinator: SupabaseSessionCoordinator,
  nonce: string,
): Promise<SupabaseSession | undefined> {
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
    const result = await authCoordinator.createSessionFromCallback({
      path: CALLBACK_PATH,
      query: trimUrlMarker(body.query, '?'),
      fragment: trimUrlMarker(body.fragment, '#'),
    });
    if (!result.success) throw new Error(result.error);

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

function parseCallbackBody(rawBody: string): {
  query?: string;
  fragment?: string;
  nonce?: string;
} {
  try {
    const body = JSON.parse(rawBody) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new RecoverableCallbackRequestError(
        'Authentication callback request was malformed.',
      );
    }

    const candidate = body as {
      query?: unknown;
      fragment?: unknown;
      nonce?: unknown;
    };
    return {
      query: typeof candidate.query === 'string' ? candidate.query : undefined,
      fragment:
        typeof candidate.fragment === 'string' ? candidate.fragment : undefined,
      nonce: typeof candidate.nonce === 'string' ? candidate.nonce : undefined,
    };
  } catch (error) {
    if (isRecoverableCallbackRequestError(error)) throw error;
    throw new RecoverableCallbackRequestError(
      'Authentication callback request was malformed.',
    );
  }
}

function isRecoverableCallbackRequestError(
  error: unknown,
): error is RecoverableCallbackRequestError {
  return error instanceof RecoverableCallbackRequestError;
}

function trimUrlMarker(value: string | undefined, marker: '?' | '#'): string {
  return value?.startsWith(marker) ? value.slice(1) : (value ?? '');
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
    const callbackFragment = window.location.hash;
    window.history.replaceState(null, document.title, window.location.pathname);
    fetch('/auth-callback/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: callbackQuery,
        fragment: callbackFragment,
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function openBrowser(
  url: string,
  log: LogBackend | undefined,
  manualBrowserHint: string,
): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `start "" "${quoteWindowsStartUrl(url)}"`]
      : [url];

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        stdio: 'ignore',
        windowsVerbatimArguments: process.platform === 'win32',
      });
    } catch (error) {
      rejectBrowserLaunch(error);
      return;
    }

    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      rejectBrowserLaunch(
        new Error(`${command} exited with code ${code ?? 'unknown'}`),
      );
    });
    child.once('error', rejectBrowserLaunch);

    function rejectBrowserLaunch(error: unknown): void {
      const message =
        error instanceof Error ? error.message : 'unknown browser launch error';
      log?.debug?.(
        'cli-auth',
        `Could not open browser automatically: ${message}`,
      );
      reject(
        new Error(
          `Could not open the browser automatically: ${message}. Run ${manualBrowserHint} to open the sign-in URL manually.`,
        ),
      );
    }
  });
}

function quoteWindowsStartUrl(url: string): string {
  return url.replaceAll('"', '%22');
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
