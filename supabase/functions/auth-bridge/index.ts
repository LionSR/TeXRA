/**
 * Auth Bridge Edge Function - OAuth hand-off page for desktop editor sign-in.
 *
 * Desktop browser-OAuth sets GoTrue's redirect_to to this https page instead of
 * straight to a raw vscode:// deep link. GoTrue server-redirects into a custom
 * scheme are silently dropped by some browsers (Firefox on Linux), which fails
 * the flow with bad_oauth_state. Redirecting to this https bridge lands the
 * user on a real page that auto-opens the editor's deep link (client-side
 * navigation, which browsers honor where they drop the server redirect) and
 * keeps a real-click "Open in <editor>" button as the fallback.
 *
 * PKCE flow: the only thing GoTrue puts on this page is a one-time ?code= in the
 * query string (or ?error= on failure). No access/refresh token ever reaches
 * the bridge; the editor exchanges the code using a verifier it never shared.
 *
 * The editor scheme and extension id ride as PATH segments
 * (/auth-bridge/<ext>/<id>) so redirect_to carries no '?' that an OAuth
 * round-trip could mangle into the function name. The page reconstructs
 * `${ext}://${id}/auth-callback` + the original query so the extension's
 * callback handler reads the code exactly as it would from the raw redirect.
 *
 * Routes:
 * - GET /auth-bridge/<ext>/<id> - The bridge HTML page (no auth header).
 *
 * Security:
 * - ext is validated server-side AND in client JS against a fixed allowlist of
 *   editor schemes; id must match a strict identifier regex. Invalid input
 *   renders a safe error page with no reflection of the raw value.
 * - The href is built only from the validated scheme + id, so no
 *   javascript:/data: scheme can be injected. All DOM writes use
 *   textContent/setAttribute; no innerHTML with untrusted data.
 * - Strict Content-Security-Policy; inline CSS/JS only; no external resources.
 *   The one-time code is scrubbed from history after the deep link is built.
 *
 * Deployment:
 *   supabase functions deploy auth-bridge --no-verify-jwt --project-ref YOUR_PROJECT_REF
 * The function URL must be on the Supabase Auth "Redirect URLs" allow-list
 * (Dashboard > Authentication > URL Configuration) as a globstar so it spans the
 * /<ext>/<id> path and the '.' in the id (a single '*' cannot):
 *   https://remote.texra.ai/functions/v1/auth-bridge**
 */

// =============================================================================
// Constants
// =============================================================================

/** Editor URI schemes allowed as the deep-link target. */
const ALLOWED_EXT_SCHEMES = [
  'vscode',
  'vscode-insiders',
  'vscodium',
  'cursor',
  'windsurf',
  'code-oss',
  'codium',
  'trae',
  'positron',
  'pearai',
] as const;

/**
 * Allowed deep-link target extension id. Locked to the TeXRA publisher so the
 * bridge can only ever hand a code back to a TeXRA extension, never an arbitrary
 * scheme://publisher.name that an attacker could place in redirect_to.
 */
const EXTENSION_ID_PATTERN = /^texra-ai\.[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// =============================================================================
// Validation
// =============================================================================

function isAllowedExtScheme(value: string | null): value is string {
  return (
    value !== null && (ALLOWED_EXT_SCHEMES as readonly string[]).includes(value)
  );
}

function isValidExtensionId(value: string | null): value is string {
  return value !== null && EXTENSION_ID_PATTERN.test(value);
}

/** Percent-decode a single path segment, returning null on malformed input. */
function decodeSegment(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// =============================================================================
// Server
// =============================================================================

Deno.serve((req: Request): Response => {
  if (req.method !== 'GET') {
    return htmlResponse(errorPageHtml('This page only responds to GET.'), 405);
  }

  // ext/id are the two path segments after "auth-bridge"
  // (/functions/v1/auth-bridge/<ext>/<id>). Read them from the path, never a
  // query, so redirect_to carries no '?'.
  const segments = new URL(req.url).pathname
    .split('/')
    .filter((segment) => segment.length > 0);
  const anchor = segments.lastIndexOf('auth-bridge');
  const ext = anchor >= 0 ? decodeSegment(segments[anchor + 1]) : null;
  const id = anchor >= 0 ? decodeSegment(segments[anchor + 2]) : null;

  // Reject unknown editors / malformed ids before rendering anything. The raw
  // value is never echoed into the HTML, so an invalid request gets a generic
  // error page (no reflection).
  if (!isAllowedExtScheme(ext) || !isValidExtensionId(id)) {
    return htmlResponse(
      errorPageHtml('This sign-in link is invalid or unsupported.'),
      400,
    );
  }

  return htmlResponse(bridgePageHtml(ext, id), 200);
});

// =============================================================================
// Response helpers
// =============================================================================

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The page handles a one-time OAuth code in the URL; keep it un-cached.
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      // Defense-in-depth: only this page's own inline style/script may run, and
      // no network/resource loads are permitted at all.
      'Content-Security-Policy': [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  });
}

// =============================================================================
// HTML
// =============================================================================

/** Shared page chrome (light, theme-aware, minimal). */
const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 30rem;
    margin: 4rem auto;
    padding: 0 1.25rem;
    line-height: 1.5;
    color: #1a202c;
    background: #fff;
  }
  h1 { font-size: 1.35rem; margin-bottom: 0.5rem; }
  p { margin: 0.75rem 0; }
  .muted { color: #718096; font-size: 0.92rem; }
  .actions { margin: 1.5rem 0 0.5rem; display: flex; flex-wrap: wrap; gap: 0.6rem; }
  a.button, button {
    font: inherit;
    font-size: 1rem;
    padding: 0.6rem 1.15rem;
    border-radius: 8px;
    border: 1px solid #cbd5e0;
    background: #fff;
    color: #1a202c;
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
  }
  a.button.primary {
    background: #2b6cb0;
    border-color: #2b6cb0;
    color: #fff;
  }
  .error { color: #c53030; }
  code { font-size: 0.9rem; word-break: break-all; }
  #status { margin-top: 0.75rem; min-height: 1.25rem; }
  .ok { color: #2f855a; }
  @media (prefers-color-scheme: dark) {
    body { color: #e2e8f0; background: #1a202c; }
    .muted { color: #a0aec0; }
    a.button, button { background: #2d3748; border-color: #4a5568; color: #e2e8f0; }
    a.button.primary { background: #3182ce; border-color: #3182ce; color: #fff; }
  }
`;

/** Wrap page body markup in the shared document shell (head + theme-aware style). */
function htmlDocument(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeXRA sign-in</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * The bridge page. Server-validated `ext`/`id` are JSON-embedded for the inline
 * script; both are also re-validated client-side before building the href, so a
 * mismatched or tampered URL never produces a javascript:/data: link.
 */
function bridgePageHtml(ext: string, id: string): string {
  return htmlDocument(`<h1 id="heading">Finish signing in to TeXRA</h1>
<p id="lede" class="muted">Click the button below to return to your editor and complete sign-in.</p>
<div class="actions">
  <a id="open" class="button primary" rel="noopener">Open in your editor</a>
  <button id="copy" type="button">Copy link</button>
</div>
<p class="muted">If nothing happens, copy this link, open the Command Palette (<strong>Cmd/Ctrl+Shift+P</strong>), run <strong>Open URL</strong>, and paste the link into the box that appears.</p>
<p><code id="link"></code></p>
<p id="status" aria-live="polite"></p>
<script>
  // ext/id are already validated server-side; mirror the checks here so a
  // tampered or reused URL can never inject a non-editor scheme into the href.
  var EXT = ${JSON.stringify(ext)};
  var ID = ${JSON.stringify(id)};
  var ALLOWED = ${JSON.stringify(ALLOWED_EXT_SCHEMES)};
  var ID_RE = new RegExp(${JSON.stringify(EXTENSION_ID_PATTERN.source)});
  var DISPLAY = {
    'vscode': 'VS Code',
    'vscode-insiders': 'VS Code Insiders',
    'vscodium': 'VSCodium',
    'cursor': 'Cursor',
    'windsurf': 'Windsurf',
    'code-oss': 'Code - OSS',
    'codium': 'VSCodium',
    'trae': 'Trae',
    'positron': 'Positron',
    'pearai': 'PearAI'
  };

  // PKCE puts the one-time code (and any error) in the query string; read
  // query-first, with the fragment as a defensive fallback.
  function paramFrom(part, name) {
    if (!part || part.length < 2) return null;
    return new URLSearchParams(part.slice(1)).get(name);
  }
  function getParam(name) {
    var fromSearch = paramFrom(window.location.search, name);
    return fromSearch !== null ? fromSearch : paramFrom(window.location.hash, name);
  }

  var heading = document.getElementById('heading');
  var lede = document.getElementById('lede');
  var openLink = document.getElementById('open');
  var copyButton = document.getElementById('copy');
  var linkCode = document.getElementById('link');
  var statusEl = document.getElementById('status');

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = kind || '';
  }

  function fail(message) {
    heading.textContent = 'Sign-in could not be completed';
    lede.textContent = message;
    lede.className = 'error';
    openLink.hidden = true;
    copyButton.hidden = true;
    linkCode.parentElement.hidden = true;
  }

  if (ALLOWED.indexOf(EXT) === -1 || !ID_RE.test(ID)) {
    fail('This sign-in link is invalid or unsupported.');
  } else {
    // Reconstruct the editor deep link: ${'$'}{EXT}://${'$'}{ID}/auth-callback plus
    // the original query (the PKCE ?code=). ext/id come from the path, so the
    // query is GoTrue's alone and rides back verbatim.
    var search = window.location.search; // includes leading '?', or ''
    var hash = window.location.hash; // includes leading '#', or ''
    var base = EXT + '://' + ID + '/auth-callback';

    var oauthError = getParam('error');
    var errorDescription = getParam('error_description');
    var hasCode = getParam('code');
    var hasToken = getParam('access_token');

    openLink.textContent = 'Open in ' + (DISPLAY[EXT] || 'your editor');

    if (oauthError) {
      // Error case: surface a human-readable message; still offer the deep link
      // so the editor sees the same error it would have on the raw redirect.
      heading.textContent = 'Sign-in did not complete';
      lede.className = 'error';
      lede.textContent =
        errorDescription || 'Authorization failed (' + oauthError + ').';
    }

    var tail = '';
    if (search && search.length > 1) {
      tail = search; // already starts with '?'
    } else if (hash && hash.length > 1) {
      tail = hash; // already starts with '#'
    }

    var deepLink = base + tail;
    openLink.setAttribute('href', deepLink);
    linkCode.textContent = deepLink;

    // Scrub the one-time code from the address bar / history. It is single-use
    // and useless without the verifier the editor never shared, but there is no
    // reason to leave it sitting in browser history.
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch (scrubErr) {
      // replaceState can throw in some sandboxed contexts; the deep link is
      // already captured above, so this is non-fatal.
    }

    copyButton.addEventListener('click', function () {
      function copied() { setStatus('Link copied to clipboard.', 'ok'); }
      function failed() { setStatus('Select the link above and copy it manually.', 'error'); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(deepLink).then(copied, failed);
      } else {
        failed();
      }
    });

    if (!oauthError && (hasCode || hasToken)) {
      // Auto-open the editor only when a usable OAuth payload is present
      // (a code or access_token, not arbitrary query params). A refresh or
      // direct visit after the history scrub has none — stay manual there.
      // The button stays as the fallback because browsers may block or
      // prompt on custom-scheme navigation (and some strip it entirely
      // without a user gesture).
      lede.textContent =
        'Opening ' + (DISPLAY[EXT] || 'your editor') +
        '… If nothing happens, click the button below.';
      setTimeout(function () {
        try {
          window.location.href = deepLink;
        } catch (navErr) {
          // Navigation refused (sandboxed/blocked scheme); the manual
          // button and copyable link above remain the path forward.
        }
      }, 200);
    }
  }
</script>`);
}

/** Generic error page that never reflects raw request input. */
function errorPageHtml(message: string): string {
  return htmlDocument(`<h1>Sign-in could not be completed</h1>
<p class="error">${escapeHtml(message)}</p>
<p class="muted">Return to your editor and start sign-in again.</p>`);
}

function escapeHtml(value: string): string {
  // Treat pre-existing entity references as literal text, not trusted markup.
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
