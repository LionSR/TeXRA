# Experimental: Sign in with Grok (xAI SuperGrok) via OAuth

**Status:** Implementation in progress (experimental, opt-in)
**Owner:** _unassigned_
**Worktree:** `feat/grok-login` (from `origin/main` @ 2026-08-04)
**Prior art studied:** OpenCode `packages/opencode/src/plugin/xai.ts` (cloned to
`/tmp/opencode`), TeXRA ChatGPT/Codex stack (`src/auth/codex/`), TeXRA Copilot
PRDs (OAuth parked; VS Code LM separate).

## Summary

Let a user sign in with their **own xAI / SuperGrok account** (OAuth) and drive
Grok models from TeXRA without pasting an `xai-…` API key — the same product
shape as **Sign in with ChatGPT** for Codex-eligible OpenAI models.

Unlike ChatGPT/Codex, Grok OAuth does **not** need a separate unofficial backend
rewrite: the access token is a Bearer credential for the **same** public
`https://api.x.ai/v1` surface the API-key path already uses (OpenCode’s loader
only injects `Authorization: Bearer <access>` and leaves the SDK base URL alone).

This is **experimental and opt-in**. It reuses the **Grok CLI’s registered OAuth
client id** (public desktop client); xAI may revoke or re-scope that registration
without notice. Do not present it as an xAI-sanctioned TeXRA partnership.

## Study notes (OpenCode + TeXRA)

### ChatGPT / Codex (already in TeXRA)

| Piece      | TeXRA today                                         | OpenCode                          |
| ---------- | --------------------------------------------------- | --------------------------------- |
| Client id  | Codex CLI `app_EMoamEEZ73f0CkXaXp7hrann`            | same                              |
| Loopback   | `localhost:1455                                     | 1457/auth/callback`               | same |
| Device     | OpenAI custom deviceauth endpoints                  | browser PKCE + device-code plugin |
| Inference  | `chatgpt.com/backend-api/codex` + account id header | same rewrite                      |
| Preference | `chatgptCodex.preferSubscription`                   | plugin OAuth record               |

TeXRA’s coordinator (single-flight refresh, generation supersede, secret store)
is the template for Grok.

### GitHub Copilot (study only — not implemented here)

OpenCode’s `github-copilot/copilot.ts` uses GitHub device OAuth (`Ov23li…`),
stores a non-expiring GitHub token, and calls `api.githubcopilot.com` with
editor-identifying headers and dynamic `/models` discovery.

TeXRA already has:

- **Official VS Code-only route** via `vscode.lm` (shipped, experimental).
- **Cross-host OAuth PRD** (`2026-06-22-copilot-oauth-handler-prd.md`) **parked**
  for ToS / account-suspension risk (unpublished APIs, impersonation headers).

OpenCode proves the route is practical; it does **not** clear TeXRA’s policy gate.
No Copilot OAuth work in this change.

### xAI / Grok (OpenCode, source of truth for this feature)

Pinned from `/tmp/opencode/packages/opencode/src/plugin/xai.ts`:

| Constant               | Value                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| Client id              | `b1a00492-073a-47ea-816f-4c329264a828` (Grok CLI public client)                 |
| Authorize              | `https://auth.x.ai/oauth2/authorize`                                            |
| Token                  | `https://auth.x.ai/oauth2/token`                                                |
| Device code            | `https://auth.x.ai/oauth2/device/code` (RFC 8628)                               |
| Scopes                 | `openid profile email offline_access grok-cli:access api:access`                |
| Loopback               | **Pinned** `http://127.0.0.1:56121/callback` (registration allow-list)          |
| Extra authorize params | `plan=generic` (required for non-allowlisted clients), `referrer` (attribution) |
| Refresh skew           | 120s (OpenCode); TeXRA uses 5 min like Codex for consistency                    |
| Inference              | Bearer on default `api.x.ai` (no base URL override)                             |

OpenCode also notes: xAI sometimes omits `expires_in`; JWT `exp` is the load-bearing
refresh signal for those tokens. Device poll honors `authorization_pending` /
`slow_down` (RFC 8628).

## Design (mirror ChatGPT)

### 1. Auth: shared OAuth machine + thin xAI policy

**Do not reinvent** the ChatGPT subscription stack. Shared primitives live in
`src/auth/oauth/`:

- PKCE, loopback callback server, single-flight refresh coordinator, error kinds

`@auth/codex` and `@auth/xai` are **policy adapters** over that machine:

| Shared (`@auth/oauth`)      | Codex-only                                | xAI-only                               |
| --------------------------- | ----------------------------------------- | -------------------------------------- |
| PKCE, loopback, coordinator | OpenAI issuer + Codex claims + deviceauth | xAI issuer + JWT exp + RFC 8628 device |

xAI keeps only:

- `xaiConstants.ts` — client id, pinned port `56121`, scopes, `plan=generic`, `referrer: texra`
- `xaiJwt.ts` / `xaiOAuthClient.ts` / `xaiDeviceLogin.ts` — protocol diffs
- thin `XaiSessionCoordinator` / loopback wrappers

Secret key: `auth.xai-grok` (outside `apiKey.*`).

### 2. Preference + model routing

- Config: `xaiGrok.preferSubscription` (default **false**), key
  `texra.xaiGrok.preferSubscription`
- Model probe: `@model/xai/xaiSignedIn` + `@model/xai/xaiPreference`
- When prefer **on** and session routable: `ModelHandlerXAI` uses OAuth access
  token as SDK `apiKey` (Bearer), same base URL as the API-key path
- Usage route: `xai-subscription` (zero list price via capability profile)
- All **xAI** registry models are eligible (no separate unofficial model allowlist)

### 3. Host surfaces

| Host      | Surface                                                              |
| --------- | -------------------------------------------------------------------- |
| CLI       | `texra auth grok login\|logout\|status` (`--device`, `--no-browser`) |
| Extension | `texra.auth.grok.signIn` + Settings → Subscriptions (Grok section)   |
| Desktop   | Settings IPC parity (`signInGrok` / prefer / status)                 |

Shared host helpers (not reinvented per provider):

- `createSubscriptionPreference(configKey)` for prefer switches
- `getSubscriptionSessionStatus` / `isSubscriptionSessionRoutable` for secret-backed access

### 4. Explicit non-goals

- Copilot OAuth / cross-host unpublished API
- Borrowing Grok CLI originator strings other than the registered client id
- Sending OAuth tokens to user-defined OpenAI-compatible endpoints
- Presenting SuperGrok as “free unlimited API”
- **xAI Responses API / `previous_response_id`** — separate PRD
  (`docs/prds/2026-08-04-prd-xai-responses-previous-response-id.md`); OAuth only
  supplies a Bearer for the same `api.x.ai` surface, whether Completions or
  Responses

## Security notes

- Same borrowed-client framing as Codex; experimental banner in UI/docs.
- Credentials only in `platform().secrets`, never plaintext config.
- Trusted inference origin: `api.x.ai` (and configured host endpoint override
  only when it remains the xAI API surface — never arbitrary custom endpoints).
- Cross-process refresh races: same known limitation as Codex; document; do not
  invent a lock in this first cut.

## Implementation sequence

1. Auth stack + unit tests (coordinator, JWT exp, device poll classification)
2. Preference + XAI handler credential path + usage route
3. CLI login
4. Extension/desktop/settings wiring
5. Changelog when user-visible surfaces land
