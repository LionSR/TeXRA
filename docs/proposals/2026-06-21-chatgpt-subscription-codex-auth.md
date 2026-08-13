# Experimental: ChatGPT-subscription login via the Codex backend

**Status:** Proposal (experimental, opt-in)
**Owner:** _unassigned_
**Tracking branch:** `claude/open-source-codex-chatgpt-tr8o0y`

## Summary

Let a user sign in with their **own ChatGPT Plus/Pro/Team subscription** and drive
OpenAI's Codex models from TeXRA, instead of paying per-token against a Platform
API key. This mirrors what [Zed](https://zed.dev/blog/chatgpt-subscription-in-zed)
and the [OpenCode Codex plugin](https://github.com/numman-ali/opencode-openai-codex-auth)
already ship: an OAuth 2.0 + PKCE login against `auth.openai.com`, then requests
routed to the undocumented Codex backend (`chatgpt.com/backend-api/codex`) with the
ChatGPT account id attached.

This is deliberately scoped as an **experimental, opt-in** provider. It rides an
unofficial endpoint and a borrowed OAuth client id, so it can break without notice
and must never be presented as an OpenAI-sanctioned integration.

## Motivation

- Many academic users already pay for ChatGPT and would rather spend that included
  Codex quota than top up a separate API-credit balance.
- The Codex model family (`gpt-5.x-codex`, `codex-mini`) is strong at the
  long-form editing / tool-use work TeXRA agents do.
- TeXRA already speaks the Responses API (see
  [`2025-06-04-openai-responses-api.md`](./2025-06-04-openai-responses-api.md) and
  `src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts`), and the Codex
  backend is **Responses-API shaped**. Most of the request/stream machinery is
  reusable; the new work is auth + endpoint + headers + model registry.

## Prior art (verified against source, not blog posts)

Both implementations were read directly from their repos. Key facts:

|                   | OpenCode plugin                                                           | Zed                                        |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| OAuth client id   | `app_EMoamEEZ73f0CkXaXp7hrann`                                            | `app_EMoamEEZ73f0CkXaXp7hrann` (identical) |
| Authorize / token | `auth.openai.com/oauth/{authorize,token}`                                 | same                                       |
| Redirect URI      | `http://localhost:1455/auth/callback`                                     | `localhost:1455`, fallback `1457`          |
| Backend base      | `chatgpt.com/backend-api` → rewrites `/responses`→`/codex/responses`      | `chatgpt.com/backend-api/codex`            |
| Headers           | `Authorization: Bearer`, `chatgpt-account-id`, `originator: codex_cli_rs` | same, `originator: zed`                    |
| Account id        | decoded from JWT claim `https://api.openai.com/auth.chatgpt_account_id`   | same (3 candidate claim locations)         |

Evidence (file:line):

- OpenCode: `lib/auth/auth.ts:6-9` (client id, authorize/token, redirect),
  `lib/constants.ts` (`CODEX_BASE_URL`), `lib/request/fetch-helpers.ts:88`
  (`/responses`→`/codex/responses`), `lib/request/fetch-helpers.ts:181-184`
  (Bearer + `chatgpt-account-id` + `originator`).
- Zed `crates/language_models/src/provider/openai_subscribed.rs`: `:34` base URL,
  `:37` client id, `:518/:529` headers, `:697-704` redirect allow-list,
  `:754` `originator=zed`.

### On the "is there a deal with OpenAI?" question

No — and the source says so. Both projects **borrow the Codex CLI's own OAuth
client id** rather than registering their own, and Zed's comments describe being
_constrained by_ that client's registration:

> `openai_subscribed.rs:697` — "The OAuth client registered for `CLIENT_ID` (the
> Codex CLI's client) only allows `…1455…` and `…1457…` as redirect URIs … Keep
> these in sync with the Codex CLI's redirect URI allow-list (see
> codex-rs/login/src/server.rs in openai/codex)."

The supported-model list is a hardcoded, going-stale mirror of `openai/codex`'s
bundled `models.json`, and the backend still rejects some requests per account
tier. This is reverse-engineering under **tacit tolerance**, not a partnership.
Treat the endpoint, client id, and model list as values that may change or be
revoked at any time.

## Design

Integration points already exist; this is additive.

### 1. New provider id

Add a `chatgpt-codex` (working name) provider distinct from the existing `openai`
API-key provider, so the two can coexist and a user can have both configured.

- **Do not** add it to `API_PROVIDERS` in `src/model/apiProviders.ts`. That
  constant is `API_KEY_PROVIDER_IDS` — membership wires a provider into the
  api-key resolution path (`apiKeySecretName` secret, `<PROVIDER>_API_KEY` env
  fallback, the Settings key-row UI), which is exactly what an OAuth-only provider
  must _not_ use. Putting it there would surface a spurious "enter API key" field
  and resolve the wrong credential.
- Instead, model it as a separate provider kind whose credential is an OAuth token
  bundle (see §3), not an api key. Concretely: a distinct provider id that is
  recognized by the model registry / handler-selection path but is **excluded**
  from `API_KEY_PROVIDER_IDS`, with its own credential lookup (OAuth coordinator)
  and its own key-status origin so the Settings → Models tab can show
  "Signed in as <email>" instead of an API-key row. If the provider-status
  plumbing (`resolveApiKey`/`lookupApiKeyOrigin`) cannot represent a non-api-key
  origin today, extending it to do so is part of this work.

### 2. Model handler (reuse the Responses handler)

`modelHandlerOpenAIResponse.ts` already builds its client via
`new OpenAI({ apiKey, baseURL })` from `getBaseUrl()` (≈ line 850) and talks
`client.responses.create(...)`. The Codex backend is the same shape. Plan:

- Subclass / parameterize the Responses handler so it can:
  - set `baseURL = https://chatgpt.com/backend-api/codex`,
  - **authenticate by passing the OAuth access token as the SDK's `apiKey`** —
    `new OpenAI({ apiKey: accessToken, baseURL })`. The OpenAI Node client derives
    `Authorization: Bearer <apiKey>` from that field, so this _is_ the bearer
    header; do **not** pass a dummy key and separately hand-set `Authorization`
    (the two would fight, and the SDK's value wins). On refresh, recreate the
    client (or use a token-getter) so the new access token is used.
  - add the **non-auth** headers via `defaultHeaders`: `chatgpt-account-id: <id>`
    and `originator: texra` (our own originator string — do **not** masquerade as
    `codex_cli_rs`).
- Where per-request token freshness matters, a custom `fetch` wrapper that injects
  the current bearer + account-id is the alternative; prefer the
  token-getter/`defaultHeaders` route over forking request code.
- Keep the `/responses` path (the `chatgpt.com/backend-api/codex` base already
  includes the `codex` segment, so the SDK's `/responses` suffix yields
  `…/codex/responses`). Verify against a live request before finalizing.

### 3. Auth flow (`src/auth/`)

Add a Codex OAuth coordinator alongside the existing Supabase coordinator. It does
**not** touch Supabase; it manages the OpenAI token bundle.

- **PKCE authorize:** open `https://auth.openai.com/oauth/authorize` with our PKCE
  challenge, the borrowed `client_id`, `redirect_uri=http://localhost:1455/auth/callback`,
  scopes `openid profile email offline_access`, `response_type=code`.
- **Loopback callback server:** bind `127.0.0.1:1455` (fallback `1457`) to capture
  `code`, exchange at `https://auth.openai.com/oauth/token` for `{access_token,
refresh_token, id_token, expires_in}`.
- **Headless / remote (important for TeXRA CLI + web sessions):** also support the
  **device-code flow** (`https://auth.openai.com/codex/device`) so SSH/container/CLI users
  who can't open a loopback browser can still log in. This is the
  [`opencode-openai-device-auth`](https://github.com/tumf/opencode-openai-device-auth)
  approach.
- **Account id:** decode the JWT `access_token`/`id_token`, read
  `https://api.openai.com/auth.chatgpt_account_id` (fall back to the other two
  claim locations Zed checks).
- **Refresh:** refresh when the token is within ~5 min of expiry (matches Codex).
- **Storage:** persist the token bundle via `platform().secrets` (host keychain on
  desktop/extension), never in plaintext config. Reuse the
  `apiKeySecretName`-style indirection but under an OAuth-specific key.

Keep all magic constants (client id, endpoints, redirect ports, originator,
model list) in **one** `codexConstants.ts` so a future OpenAI change is a
one-file edit.

### 4. Model registry & pricing

- Register the Codex-visible models in `src/model/computeModelOptions.ts` under the
  new provider, mirroring `openai/codex`'s `models.json` picker set
  (`gpt-5.x-codex`, `gpt-5.x-codex-mini`, etc.).
- Pricing/usage is **subscription-included, not per-token** — surface it as
  "included in your ChatGPT plan (rate-limited)" rather than a $/token cost, and
  expect the backend to reject models above the account's tier (handle the 401/403
  gracefully with a clear message).

### 5. Platform / VS Code separation

Per `CLAUDE.md`, `src/agent/` and `src/model/` are VS Code-free zones and must
not import `vscode`. (`src/auth/` is listed under CLAUDE.md's _VS Code-allowed_
zones, but in practice it is host-agnostic — it only reaches host services through
`@platform` — so the Codex coordinator added here should keep that property and
stay `vscode`-free too.)

- The loopback server, browser-open, and keychain access go through existing host
  ports (`platform().secrets`, the opener host capability), not `vscode` imports.
- The login _command_ (button in Settings → Models) lives in
  `packages/extension/src/commands/auth/` and calls the host-neutral coordinator.

## UX

- Settings → Models gains a **"Sign in with ChatGPT (experimental)"** action next
  to the OpenAI API-key field, clearly labeled experimental / personal-use.
- After sign-in: show `Signed in as <email>` + a Sign-out button; Codex models
  appear in the model picker.
- CLI: `texra` gains an equivalent `texra auth chatgpt` (login/logout/status)
  following clig.dev conventions, defaulting to device-code on non-TTY.

## Security, ToS, and framing (non-negotiable)

- **Opt-in only**, off by default, behind an experimental flag.
- Use **our own** `originator` string; do not impersonate the Codex CLI's
  `codex_cli_rs`.
- Label everywhere as "use your **own** ChatGPT subscription, personal use." Do not
  claim OpenAI endorsement. OpenAI's Services Agreement prohibits sharing account
  credentials; this feature only ever uses the signed-in user's own session.
- Tokens in the OS keychain via `platform().secrets`; never logged, never synced.
- Document that the endpoint/client id are unofficial and may break; fail with a
  clear, actionable error (re-login / fall back to API key) rather than a raw 401.

## Scope

**In:** OAuth PKCE + device-code login, token storage/refresh, a Codex Responses
handler variant, Codex model registry entries, Settings + CLI sign-in, experimental
flag, docs.

**Out (for v0):** dynamic `GET /models` discovery (hardcode + refresh later),
non-Codex ChatGPT features, Team/Enterprise SSO edge cases, any attempt to use
this for shared/server deployments.

## Open questions

1. Provider id naming: `chatgpt-codex` vs `openai-subscription` vs `codex`.
2. Do we reuse the borrowed Codex client id (works today, fragile) or wait/ask for
   an official "Sign in with ChatGPT" client
   ([openai/codex#10974](https://github.com/openai/codex/issues/10974))? v0:
   borrow, but isolate so we can swap.
3. How to represent subscription "pricing" in usage/telemetry that assumes $/token.
4. Rate-limit handling: surface remaining Codex quota if the backend returns it.

## Rollout

1. Land constants + auth coordinator + token storage (no UI) with unit tests for
   PKCE, JWT claim extraction, and refresh.
2. Add the Codex Responses handler variant; verify a live `…/codex/responses` call.
3. Wire Settings + CLI sign-in behind the experimental flag.
4. Register models; document in CHANGELOG under an "Experimental" heading.

## References

- Zed: [blog](https://zed.dev/blog/chatgpt-subscription-in-zed),
  [PR #56811](https://github.com/zed-industries/zed/pull/56811),
  `crates/language_models/src/provider/openai_subscribed.rs`
- OpenCode: [numman-ali/opencode-openai-codex-auth](https://github.com/numman-ali/opencode-openai-codex-auth),
  [open-hax/codex](https://github.com/open-hax/codex),
  [device auth](https://github.com/tumf/opencode-openai-device-auth)
- OpenAI: [Codex auth](https://developers.openai.com/codex/auth),
  [using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan),
  [Services Agreement](https://openai.com/policies/services-agreement/)
- Third-party sign-in feature request: [openai/codex#10974](https://github.com/openai/codex/issues/10974)
