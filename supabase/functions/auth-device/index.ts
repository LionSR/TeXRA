/**
 * Auth Device Edge Function - RFC 8628-style device authorization for TeXRA.
 *
 * Lets headless terminals (SSH, WSL2, containers) sign in without a loopback
 * callback server: the CLI requests a device code here, shows the user a short
 * code plus a verification URL, and polls for completion. The user opens the
 * URL in a browser on ANY device, signs in with the normal Supabase OAuth web
 * flow, and approves the code. The poll endpoint then mints a NATIVE GoTrue
 * session (same magic-link mint as auth-github), so tokens refresh through
 * GoTrue's standard rotation.
 *
 * Routes:
 * - POST /code    - Start a device authorization (anonymous; returns
 *                   device_code, user_code, verification URIs, expiry, interval)
 * - GET  /verify  - Browser verification page (sign in + approve/deny the code)
 * - POST /approve - Approve or deny a user code (requires a user JWT)
 * - POST /token   - CLI poll endpoint; RFC 8628 error codes until approved,
 *                   then a one-time session payload (auth-github shape)
 *
 * Security:
 * - Device codes are high-entropy bearer secrets, stored only as SHA-256
 *   hashes; rows are service-role only (see device_auth_requests migration)
 * - User codes are short-lived (15 min), single-use, and can only be approved
 *   by an authenticated browser session
 * - Polling is rate-limited per request via poll_interval_seconds (slow_down)
 *
 * Deployment note: the OAuth redirect back to GET /verify must be allow-listed
 * in the Supabase Auth URL configuration (e.g. https://remote.texra.ai/functions/v1/auth-device/verify).
 */

import { type Context as HonoContext, Hono } from '@hono/hono';
import { parseApprovalDecision } from './approvalRequest.ts';
import { authenticateJwt, bearerToken } from '../_shared/auth.ts';
import { getCorsHeaders, handleCors } from '../_shared/cors.ts';
import { randomBase64Url, sha256Hex } from '../_shared/crypto.ts';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../_shared/edgeClients.ts';
import {
  requireSupabaseClients,
  type SupabaseClientVariables,
} from '../_shared/edgeMiddleware.ts';
import {
  mintGoTrueSession,
  sessionResponseBody,
} from '../_shared/goTrueSession.ts';
import { errorResponse, jsonResponse } from '../_shared/responses.ts';

// =============================================================================
// Constants
// =============================================================================

/** Device authorization lifetime. */
const DEVICE_CODE_TTL_SECONDS = 15 * 60;

/** Initial poll interval the CLI must respect (RFC 8628 default). */
const POLL_INTERVAL_SECONDS = 5;

/** Interval bump applied on slow_down (RFC 8628 section 3.5). */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** Tolerance so well-behaved clients aren't punished for clock jitter. */
const POLL_TOLERANCE_MS = 500;

/**
 * User-code alphabet: no vowels (no accidental words) and no 0/O/1/I
 * lookalikes. 8 chars over 28 symbols ~= 38 bits, plenty for a 15-minute,
 * single-use code that can only be approved by an authenticated user.
 */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_BYTES = 32;
const USER_CODE_INSERT_ATTEMPTS = 4;

// =============================================================================
// Hono App
// =============================================================================

// The edge runtime hands over paths including the function slug
// (/auth-device/code), same as the auth-github function.
const app = new Hono<{ Variables: SupabaseClientVariables }>().basePath(
  '/auth-device',
);

// CORS middleware. The verification page is served from this same origin, so
// same-origin browser fetches (which may carry a *.supabase.co Origin not in
// the shared allow-list) are let through before the shared origin check.
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin && origin === new URL(c.req.url).origin) {
    await next();
    return;
  }
  const response = handleCors(c.req.raw);
  if (response) return response;
  await next();
});

app.use('*', requireSupabaseClients);

// =============================================================================
// Helpers
// =============================================================================

type Context = HonoContext<{ Variables: SupabaseClientVariables }>;

function randomUserCode(): string {
  const bytes = new Uint8Array(USER_CODE_LENGTH * 2);
  crypto.getRandomValues(bytes);
  let code = '';
  // Rejection sampling keeps the distribution uniform over the alphabet.
  const limit = 256 - (256 % USER_CODE_ALPHABET.length);
  for (const byte of bytes) {
    if (byte >= limit) continue;
    code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    if (code.length === USER_CODE_LENGTH) return code;
  }
  // Astronomically unlikely to run dry; recurse for the missing tail.
  return (code + randomUserCode()).slice(0, USER_CODE_LENGTH);
}

/** XXXX-XXXX display form shown to humans. */
function formatUserCode(userCode: string): string {
  return `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
}

/** Accept pasted codes with any case, spaces, or hyphens. */
function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function verificationUri(c: Context): string {
  // Public URL of this function's /verify route. The platform router strips
  // /functions/v1 before handing the request to the function, so add it back.
  return `${new URL(c.req.url).origin}/functions/v1/auth-device/verify`;
}

// =============================================================================
// Routes
// =============================================================================

// POST /code - Start a device authorization (anonymous).
app.post('/code', async (c) => {
  try {
    const supabase = c.get('supabase');

    // Opportunistic cleanup keeps the table from accumulating abandoned rows.
    await supabase
      .from('device_auth_requests')
      .delete()
      .lt('expires_at', new Date().toISOString());

    const deviceCode = randomBase64Url(DEVICE_CODE_BYTES);
    const deviceCodeHash = await sha256Hex(deviceCode);
    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);

    let userCode: string | null = null;
    for (let attempt = 0; attempt < USER_CODE_INSERT_ATTEMPTS; attempt += 1) {
      const candidate = randomUserCode();
      const { error } = await supabase.from('device_auth_requests').insert({
        device_code_hash: deviceCodeHash,
        user_code: candidate,
        status: 'pending',
        poll_interval_seconds: POLL_INTERVAL_SECONDS,
        expires_at: expiresAt.toISOString(),
      });
      if (!error) {
        userCode = candidate;
        break;
      }
      // 23505 = unique_violation: user_code collision, retry with a new code.
      if (error.code !== '23505') {
        console.error('[DEVICE] insert failed:', error.message);
        return errorResponse(
          c.req.raw,
          'Failed to start device authorization',
          500,
        );
      }
    }
    if (!userCode) {
      return errorResponse(
        c.req.raw,
        'Failed to start device authorization',
        500,
      );
    }

    const verifyUri = verificationUri(c);
    const displayCode = formatUserCode(userCode);
    return jsonResponse(
      c.req.raw,
      {
        device_code: deviceCode,
        user_code: displayCode,
        verification_uri: verifyUri,
        verification_uri_complete: `${verifyUri}?device_code=${encodeURIComponent(
          displayCode,
        )}`,
        expires_in: DEVICE_CODE_TTL_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      },
      200,
    );
  } catch (error) {
    console.error('[DEVICE] code error:', error);
    return errorResponse(c.req.raw, 'Internal server error', 500);
  }
});

// POST /approve - Approve or deny a pending user code (signed-in browser user).
app.post('/approve', async (c) => {
  try {
    const auth = await authenticateJwt(bearerToken(c.req.raw));
    if (!auth) {
      return errorResponse(
        c.req.raw,
        'Sign in before approving a device code',
        401,
      );
    }

    const body = await c.req.json().catch(() => null);
    const rawCode = typeof body?.user_code === 'string' ? body.user_code : '';
    const userCode = normalizeUserCode(rawCode);
    if (userCode.length !== USER_CODE_LENGTH) {
      return errorResponse(
        c.req.raw,
        'Enter the code shown in your terminal',
        400,
      );
    }
    const approve = parseApprovalDecision(body);
    if (approve === null) {
      return errorResponse(
        c.req.raw,
        'Approval decision must be true or false',
        400,
      );
    }

    const { data, error } = await c
      .get('supabase')
      .from('device_auth_requests')
      .update({
        status: approve ? 'approved' : 'denied',
        user_id: auth.user.id,
      })
      .eq('user_code', userCode)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .select('id');

    if (error) {
      console.error('[DEVICE] approve failed:', error.message);
      return errorResponse(c.req.raw, 'Failed to update device code', 500);
    }
    if (!data?.length) {
      return errorResponse(
        c.req.raw,
        'That code was not found or has expired. Check your terminal for the current code.',
        404,
      );
    }

    console.log(
      `[DEVICE] code ${
        approve ? 'approved' : 'denied'
      } by user ${auth.user.id}`,
    );
    return jsonResponse(
      c.req.raw,
      { status: approve ? 'approved' : 'denied' },
      200,
    );
  } catch (error) {
    console.error('[DEVICE] approve error:', error);
    return errorResponse(c.req.raw, 'Internal server error', 500);
  }
});

// POST /token - CLI poll endpoint. RFC 8628 error codes until approved.
app.post('/token', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const deviceCode =
      typeof body?.device_code === 'string' ? body.device_code : '';
    if (!deviceCode) {
      return errorResponse(c.req.raw, 'invalid_grant', 400);
    }

    const supabase = c.get('supabase');
    const deviceCodeHash = await sha256Hex(deviceCode);
    const { data: row, error } = await supabase
      .from('device_auth_requests')
      .select(
        'id, status, expires_at, last_polled_at, poll_interval_seconds, user_id',
      )
      .eq('device_code_hash', deviceCodeHash)
      .maybeSingle();

    if (error) {
      console.error('[DEVICE] token lookup failed:', error.message);
      return errorResponse(c.req.raw, 'Internal server error', 500);
    }
    if (!row) {
      return errorResponse(c.req.raw, 'invalid_grant', 400);
    }

    const deleteRow = () =>
      supabase.from('device_auth_requests').delete().eq('id', row.id);

    const now = Date.now();
    if (new Date(row.expires_at).getTime() <= now) {
      await deleteRow();
      return errorResponse(c.req.raw, 'expired_token', 400);
    }

    if (row.status === 'denied') {
      await deleteRow();
      return errorResponse(c.req.raw, 'access_denied', 400);
    }

    if (row.status === 'pending') {
      const lastPolled = row.last_polled_at
        ? new Date(row.last_polled_at).getTime()
        : 0;
      const minGapMs = row.poll_interval_seconds * 1000 - POLL_TOLERANCE_MS;
      const tooFast = now - lastPolled < minGapMs;
      await supabase
        .from('device_auth_requests')
        .update({
          last_polled_at: new Date(now).toISOString(),
          ...(tooFast && {
            poll_interval_seconds:
              row.poll_interval_seconds + SLOW_DOWN_INCREMENT_SECONDS,
          }),
        })
        .eq('id', row.id);
      return errorResponse(
        c.req.raw,
        tooFast ? 'slow_down' : 'authorization_pending',
        400,
      );
    }

    // Approved: look up the owner (row intact, so a transient lookup
    // failure stays retryable), then atomically claim the row before
    // minting. The conditional delete lets exactly one poll win a race —
    // any concurrent poll sees no claimed row and gets invalid_grant, so a
    // single approval can never mint two sessions.
    const { data: userData, error: userError } =
      await supabase.auth.admin.getUserById(row.user_id);
    const email = userData?.user?.email;
    if (userError || !email) {
      console.error(
        '[DEVICE] approved user lookup failed:',
        userError?.message ?? 'no email',
      );
      await deleteRow();
      return errorResponse(c.req.raw, 'Failed to create session', 500);
    }

    const { data: claimed, error: claimError } = await supabase
      .from('device_auth_requests')
      .delete()
      .eq('id', row.id)
      .eq('status', 'approved')
      .select('id');
    if (claimError) {
      console.error('[DEVICE] claim failed:', claimError.message);
      return errorResponse(c.req.raw, 'Internal server error', 500);
    }
    if (!claimed?.length) {
      // Another poll already redeemed this device code.
      return errorResponse(c.req.raw, 'invalid_grant', 400);
    }

    const session = await mintGoTrueSession(
      supabase,
      c.get('authClient'),
      email,
      row.user_id,
      '[DEVICE]',
    );
    if (!session) {
      // The claim is already burned — device codes are strictly single-use,
      // so a mint failure here ends the flow and the user re-runs login.
      return errorResponse(c.req.raw, 'Failed to create session', 500);
    }

    console.log(`[DEVICE] token issued for user ${row.user_id}`);
    return jsonResponse(c.req.raw, sessionResponseBody(session), 200);
  } catch (error) {
    console.error('[DEVICE] token error:', error);
    return errorResponse(c.req.raw, 'Internal server error', 500);
  }
});

// GET /verify - Browser verification page.
app.get('/verify', (c) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return errorResponse(c.req.raw, 'Server configuration error', 500);
  }
  const scriptNonce = randomBase64Url(16);
  return new Response(
    verifyPageHtml(SUPABASE_URL, SUPABASE_ANON_KEY, scriptNonce),
    {
      status: 200,
      headers: {
        ...getCorsHeaders(c.req.raw),
        'Content-Type': 'text/html; charset=utf-8',
        // The page handles OAuth tokens in the URL fragment; keep it un-cached.
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        // Defense-in-depth: only the nonced inline module plus esm.sh may run
        // scripts, and network calls are limited to GoTrue and this function.
        'Content-Security-Policy': [
          "default-src 'none'",
          `script-src 'nonce-${scriptNonce}' https://esm.sh`,
          `connect-src 'self' ${new URL(SUPABASE_URL).origin}`,
          "style-src 'unsafe-inline'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      },
    },
  );
});

// 404 for other routes
app.all('*', (c) => errorResponse(c.req.raw, 'Not found', 404));

Deno.serve(app.fetch);

// =============================================================================
// Verification page
// =============================================================================

function verifyPageHtml(
  projectUrl: string,
  anonKey: string,
  scriptNonce: string,
): string {
  // Static page: sign in with the normal Supabase OAuth web flow (redirecting
  // back here, keeping ?device_code= through the round trip), then approve or
  // deny the code with the signed-in user's JWT. Supabase owns ?code= for the
  // OAuth PKCE callback, so the device user code must use a distinct query
  // key. Despite the name, ?device_code= carries the short DISPLAY code the
  // user enters (XXXX-XXXX), never the high-entropy device-code secret.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeXRA device sign-in</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1rem; color: #1a202c; }
  h1 { font-size: 1.3rem; }
  input { font-size: 1.4rem; letter-spacing: 0.2em; text-transform: uppercase; width: 100%; box-sizing: border-box; padding: 0.5rem; margin: 0.75rem 0; border: 1px solid #cbd5e0; border-radius: 6px; text-align: center; }
  button { font-size: 1rem; padding: 0.55rem 1.1rem; margin: 0.25rem 0.5rem 0.25rem 0; border-radius: 6px; border: 1px solid #cbd5e0; background: #fff; cursor: pointer; }
  button.primary { background: #2b6cb0; border-color: #2b6cb0; color: #fff; }
  .muted { color: #718096; font-size: 0.9rem; }
  #status { margin-top: 1rem; }
  .error { color: #c53030; }
  .ok { color: #2f855a; }
</style>
</head>
<body>
<h1>TeXRA device sign-in</h1>
<p class="muted">Approve the sign-in request from your terminal. Only continue if you started this from <code>texra login</code>.</p>
<input id="code" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX" aria-label="Device code">
<div id="signed-out" hidden>
  <button class="primary" data-provider="github">Continue with GitHub</button>
  <button class="primary" data-provider="google">Continue with Google</button>
</div>
<div id="signed-in" hidden>
  <p id="account" class="muted"></p>
  <button id="approve" class="primary">Approve sign-in</button>
  <button id="deny">Deny</button>
</div>
<p id="status"></p>
<script type="module" nonce="${scriptNonce}">
  import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

  const supabase = createClient(${JSON.stringify(projectUrl)}, ${JSON.stringify(
    anonKey,
  )});
  const codeInput = document.getElementById('code');
  const statusEl = document.getElementById('status');
  const signedOut = document.getElementById('signed-out');
  const signedIn = document.getElementById('signed-in');

  const params = new URLSearchParams(window.location.search);
  if (params.get('device_code')) codeInput.value = params.get('device_code');

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = kind || '';
  }

  function requireCode() {
    const code = codeInput.value.trim();
    if (!code) {
      setStatus('Enter the code shown in your terminal.', 'error');
      return null;
    }
    return code;
  }

  async function refresh() {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    signedOut.hidden = Boolean(session);
    signedIn.hidden = !session;
    if (session) {
      document.getElementById('account').textContent =
        'Signed in as ' + (session.user.email || session.user.id) + '.';
    }
  }

  for (const button of signedOut.querySelectorAll('button')) {
    button.addEventListener('click', async () => {
      const code = requireCode();
      if (!code) return;
      const redirectTo = window.location.origin + window.location.pathname +
        '?device_code=' + encodeURIComponent(code);
      const { error } = await supabase.auth.signInWithOAuth({
        provider: button.dataset.provider,
        options: { redirectTo },
      });
      if (error) setStatus('Sign-in failed: ' + error.message, 'error');
    });
  }

  async function decide(approve) {
    const code = requireCode();
    if (!code) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      setStatus('Sign in first.', 'error');
      return;
    }
    setStatus(approve ? 'Approving…' : 'Denying…');
    const response = await fetch('./approve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + data.session.access_token,
      },
      body: JSON.stringify({ user_code: code, approve }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setStatus(body.error || 'Something went wrong. Try again.', 'error');
      return;
    }
    setStatus(
      approve
        ? 'Approved. Return to your terminal — it will finish signing in shortly. You can close this tab.'
        : 'Denied. The terminal request was rejected. You can close this tab.',
      'ok',
    );
    signedIn.hidden = true;
    codeInput.disabled = true;
  }

  document.getElementById('approve').addEventListener('click', () => decide(true));
  document.getElementById('deny').addEventListener('click', () => decide(false));

  await refresh();
  supabase.auth.onAuthStateChange(() => { void refresh(); });
</script>
</body>
</html>`;
}
