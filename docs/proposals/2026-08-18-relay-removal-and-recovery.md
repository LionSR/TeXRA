# Relay ("Included Model Access") — Removal Record and Recovery Guide

**Status:** Removal in progress (this PR and a follow-up).
**Pre-removal reference SHA:** `e9dbd7fd9b28153a5cc908a27c9096f4590f03a7` — the last
commit on `main` where every relay surface described below exists and its test
suites ran green. `git show <SHA>:<path>` recovers any file named here.
**Preserved sources:** `attic/supabase-relay/` (server edge functions, deploy
script, setup docs, parity tests — see its README).

This document is the single recovery artifact for the relay. It records why
relay was removed, the complete architecture as it stood, every contract that
would need to be re-established to bring it back, and the operational sunset as
executed. It is intentionally detailed: the goal is that a future engineer can
rebuild the feature from this document plus the attic sources without
archaeology.

## 1. What was removed and why

TeXRA offered three ways to pay for model calls:

1. **Your own API keys** (BYOK) — kept.
2. **Provider subscriptions** (Claude, Codex/ChatGPT, Kimi Code, GLM Coding
   Plan, Grok OAuth) — kept.
3. **Relay / "Included access"** — TeXRA-hosted proxying of provider APIs
   through a Supabase edge function using TeXRA's own provider keys, gated by
   TeXRA account tiers — **removed**.

Reasons: (i) the provider-key cost was hard to sustain; (ii) provider
subscriptions took over the "no API key" use case; (iii) three access modes
confused users and code alike (every credential-resolution path had a
three-way branch); (iv) a TeXRA-operated paid proxy is a poor fit for open
source.

**Kept deliberately:** TeXRA account sign-in (Supabase auth) — it still serves
the remote-agent catalog (`get-agent-config`) and telemetry attribution — and
the `log-usage` telemetry edge function. Only the included-access plane went.

## 2. Architecture: two planes

```
  ACCOUNT PLANE (kept)                    INCLUDED-ACCESS PLANE (removed)
  ─────────────────────                   ────────────────────────────────
  SupabaseClient (GoTrue session)   ┌──►  IncludedModelAccess seam
  auth-github / auth-device /       │       (src/model/includedModelAccess.ts)
  auth-bridge edge fns              │            │ installed by
  get-agent-config (remote agents)  │       installTexraModelAccess()
  log-usage (telemetry)             │            │
                                    │       ServerSideKeyService ──── TierService
                                    │            │  (access decision,    (tier-config
                                    │            │   quota auto-switch)   fetch+cache)
       getRelayAccessToken() ───────┘            │
       (session JWT or CI token)                 ▼
                                        relay edge function
                                        /functions/v1/relay/<provider>/…
                                        (validates JWT/CI token, checks tier,
                                         spend, rate; swaps in TeXRA's key)
                                                 │
                                                 ▼
                                        upstream provider APIs
```

The model layer knew nothing about Supabase. It asked questions through the
**`IncludedModelAccess` seam** (may this model route through included access,
at what URL, with what token); the app answered by installing TeXRA's
implementation at startup. An embedder that installed nothing got `BYOK_ONLY`
(every gate answers "no"). This seam design is the part most worth re-landing
verbatim on recovery — it kept `src/model/` and `src/agent/` free of any auth
or Supabase import.

## 3. The client seam (`src/model/includedModelAccess.ts`)

Interface members (each a question the model layer asks; see the SHA for full
doc comments):

| Member | Answer it gave |
| --- | --- |
| `getUseIncludedModelAccess()` | user toggle on at all? |
| `isAuthenticated()` | account session exists (distinguishes "not signed in" from "tier doesn't cover model") |
| `canUseServerSideKeys()` | async access decision; primes caches |
| `canUseModelSync(model)` | primed tier cache covers this model? |
| `isProviderOnServer(provider)` | provider served by relay at all? |
| `shouldUseServerSideKeysSync(provider, model?)` | combined sync gate on the dispatch hot path |
| `wasQuotaAutoSwitched()` / `isRelayQuotaExceeded()` | quota-flip status for UI/error copy |
| `getRelayBaseUrl(provider)` | per-provider relay base URL |
| `getAccessToken(forceRefresh?)` / `isAccessTokenExpiringSoon()` | bearer credential + proactive-refresh probe |
| `capReasoningEffort(model, effort)` | tier cap on GPT-5 reasoning effort |

Installed once per process from each host composition root, next to
`initPlatform()`:
`src/controllers/modelAccess/installTexraModelAccess.ts` called
`setIncludedModelAccess(TEXRA_INCLUDED_MODEL_ACCESS)` — an object whose every
member re-read `getServerSideKeyService()` (lazily constructed singleton that
sign-in and tests replace). `BYOK_ONLY.getRelayBaseUrl` **threw** — unreachable
behind the gates, and a fabricated URL would address requests to nothing.

Default was BYOK deliberately, not "off only when nothing is configured":
routing a process's model traffic and billing through someone else's servers
must be an explicit app decision, never a library default.

## 4. Client implementation

### 4.1 `ServerSideKeyService` (`src/auth/serverKeys/ServerSideKeyService.ts`)

The access decision owner. Key behaviors to reproduce:

- **Usage pattern:** async `canUseServerSideKeys()` primes caches; sync methods
  (`isProviderOnServer`, `canUseModelSync`, `shouldUseServerSideKeysSync`)
  answer from the committed `AccessSnapshot` and return `false` until a fetch
  commits. The snapshot commits `{granted, userTier, authenticated, cachedAt}`
  as a unit at a single boundary; a superseded fetch may return its own result
  but never alters the canonical snapshot (latest-fetch-wins via promise
  identity comparison).
- **Access requires all of:** user toggle on, authenticated session, tier
  config fetched, and **`providers.length > 0`** — the last gate is what made
  the server-side sunset graceful (see §11): serving an empty provider list
  flipped every old client to BYOK with no code change.
- **Anonymous-fetch backoff (30 s):** a dead session on the model-dispatch hot
  path would otherwise retry the full relay fetch + token refresh per call.
  Denied anonymous fetches negative-cache for 30 s; granted-but-tokenless ones
  may retry (the token may appear next attempt). Authenticated
  transport/config failures cache no timestamp (immediately retryable).
- **Quota auto-switch:** on detecting an exhausted monthly quota during an
  access check, the service flipped the persisted toggle
  `texra.useIncludedModelAccess` to `false` **once per session**
  (`quotaFlipApplied` one-shot), preserving the TierService cache so the
  spending-status explanation survived the flip. The user could re-enable
  manually; the service would not fight that decision. Settings UI showed the
  flip so routing never changed silently.
- **Relay URL construction:** `getRelayBaseUrl(provider)` =
  `${baseUrl}/functions/v1/relay/${provider}${suffix}` with per-provider SDK
  path suffixes: openai/xai/deepseek/moonshot/minimax `/v1`, dashscope
  `/compatible-mode/v1`, glm `/api/paas/v4`, anthropic/google no suffix.
- **Persisted preference:** global state key `texra.useIncludedModelAccess`
  (default `true`, `?? true` normalizing a hand-edited `null`). A host without
  a state store started with included access **off** — only a host that can
  surface the setting may opt the process in.

### 4.2 `TierService` (`src/auth/serverKeys/TierService.ts`)

Fetches `GET {baseUrl}/functions/v1/relay/tier-config` and caches it in an
`LRUCache` (max 2, TTL 5 min = `SERVER_SIDE_CACHE_TTL_MS`) **keyed by auth
state** (`'auth'` / `'anon'`) so a late anonymous response can never clobber an
authenticated spend snapshot — structural, not timing-based. `clearCache()`
aborts in-flight fetches via `AbortSignal` so a post-sign-out response cannot
repopulate snapshots. Sync accessors serve the last good `configSnapshot` past
TTL until the next fetch. Also owned: `userStatus` (tier, expiry, ban),
`spendingStatus`, `spendingStatusError`, `isQuotaExceeded()`,
`isAccessExpired()`, `isModelAvailable(tier, model)`.

### 4.3 `SupabaseClient` relay methods (`src/auth/SupabaseClient.ts`)

- `getRelayAccessToken(forceRefresh?)`: the CI relay token from the
  environment if configured, else the GoTrue session access token (refreshing
  when needed). Only relay-bound calls used this; normal Supabase APIs always
  used session tokens.
- `getUserTier()` / `getSessionTier()`: tier from the tier-config user status
  (CI-token path) or the session profile.
- `hasUsableRelayToken()`: sync check backing `isAuthenticated()` so a CI
  token counted as signed in for relay purposes.

### 4.4 CI relay tokens (`src/auth/relayToken.ts`, CLI `texra setup-token`)

Long-lived bearer credentials for headless pipelines, deliberately distinct
from Supabase sessions:

- Env var `TEXRA_RELAY_TOKEN`; format `texra_relay_<32 random bytes base64url>`.
  **The prefix was duplicated** in `supabase/functions/_shared/relayCiToken.ts`
  (Deno cannot import client source); parity enforced by
  `RelaySharedConfigParity.vitest.ts`.
- Malformed/unprefixed values were ignored entirely so a bad env var could not
  hijack session auth.
- Validity probed via the tier-config endpoint (the only profile surface a
  relay-scoped token could reach): 401/403 → `invalid`; missing `userStatus`
  in an OK response → `invalid` (server answered, credential unrecognized);
  network/5xx → `unknown` (never cached). A live relay 401 called
  `markRelayTokenRejected()` — authoritative, sticky against stale in-flight
  probes (re-read after probe, `invalid` wins).
- Sign-out UX: clearing the stored session does not unset the environment, so
  both GUI and CLI showed a "TEXRA_RELAY_TOKEN still keeps included access
  active" notice.
- CLI surface: `texra setup-token` (mint, prints token once to stdout for
  command substitution, guidance to stderr), `texra auth token list`,
  `texra auth token revoke <id>`.
- Server: `relay-tokens` edge function (attic). Mint/list/revoke require a
  **user JWT** — a CI token cannot manage tokens, bounding leak blast radius.
  Plaintext returned exactly once; SHA-256 hash-at-rest in
  `public.relay_ci_tokens` (service-role only) with name, `…XXXX` hint,
  scopes (fixed `['relay']`), expiry (default 30 d, max 365 d), max 10 active
  tokens per user, throttled `last_used_at` audit refresh (60 s).

### 4.5 Request-path token flows (`src/agent/core/flows/ModelInvocationNode.ts`)

- **Proactive refresh:** before a relay-routed request
  (`services.modelCell.route === 'relay'`), if
  `isAccessTokenExpiringSoon()` then `getAccessToken(true)`; for a CI token
  this was a cache-only no-op.
- **Reactive 401 recovery:** on a relay 401 (`isRelayError` or relay route),
  refresh the token once and retry once (`attemptRelay401Recovery`), rebinding
  the client only when the token actually rotated.
- **Retry gating:** relay admission failures (`rateLimitScope 'relay-limit'`
  or `'relay-user'`) were "unobserved failures" — they did not poison sibling
  models sharing the credential/endpoint in the retry gate. A trailing retry
  route `relay:user-request-gate` handled per-user gate 429s with the server's
  `retryAfterSeconds`.

### 4.6 Reasoning-effort caps (client half)

`installTexraModelAccess.capIncludedReasoningEffort`: GPT-5-family models
requesting `xhigh`/`max` were capped by tier — Max → `high`, free → `medium`,
Ultra/unknown uncapped. Applied **only on the included-access route**; a direct
API key was never capped. The server enforced the same caps (§6.5) so direct
relay callers couldn't bypass the client.

## 5. Wire contracts and schemas (client side)

- `UsageRoute` gained `'relay'` (`src/shared/schemas/usage.ts`) — **the enum
  member survives removal** as a tolerated legacy value so persisted NDJSON
  transcripts keep rendering; producers are gone. Same for the
  `usageRouteBadge` `'relay'` branch ("Included access" / "Included") in
  `src/shared/copy/modelAccess.ts`. Planned deletion after 2026-11.
- `ExhaustionReason 'relay-limit'` + `isRelayError` flag
  (`src/shared/schemas/errors.ts`) — removed; they traveled only in ephemeral
  retry-state messages.
- `SpendingStatus` / `SpendingStatusError` (`src/shared/schemas/spendingStatus.ts`,
  deleted — schema preserved in §6.2 below): `{currentSpend, limit, remaining,
  percentUsed}` in USD, UTC calendar month; error shape `{spendCheckFailed,
  failureReason?, limit?}`. Quota meter warned at 80 % (`spendingQuotaState`:
  ok / warning / exhausted), shared by Settings and the CLI status bar.
- `QuotaFallbackRoute.disableIncludedAccess` (`src/shared/quotaFallbackRoutes.ts`)
  — removed; when a quota fallback switched routes it also had to turn off
  included access so the retry could not still prefer the relay JWT.
- Relay error detection (`src/common/errors/sdkError/relayDetection.ts`,
  deleted): `isRelayError(rawErrorBody)` = any error-body candidate contains a
  `_relay` key (the relay stamped `_relay: <version>` into every error
  envelope, §6.4). Also housed provider error-type→status inference which was
  relay-independent and was retained elsewhere.
- User-facing vocabulary (`src/shared/copy/modelAccess.ts`): the transport
  ("relay") and wire identifiers (`included`/`personal`) never reached the
  screen; users saw **"Included access"** vs **"Your own API keys"**. CLI
  accepted `included|relay|personal|byok` for `--api-mode` / `/api-mode`
  (concept deleted with the relay — one remaining value is not a mode).

## 6. The relay edge function (server; sources in attic)

`supabase/functions/relay/` — Hono app, base path `/relay`, relay version
header/envelope `RELAY_VERSION` (last `1.10.0`).

### 6.1 Endpoints

- `GET /relay/providers` (public): `{_relay, providers}` — providers whose
  key env var is set, computed once per isolate (secrets changes restart the
  function).
- `GET /relay/tier-config` (public + optional auth): static `TIER_CONFIG`
  (providers, per-tier model lists) + `spendingLimits`; when the request
  carries a resolvable credential, adds `userStatus {tier, accessExpiresAt,
  isExpired, daysRemaining, isBanned}` and `spendingStatus` (or
  `spendingStatusError` when the spend RPC failed).
- `ALL /relay/:provider/*`: the proxy. Full enforcement order in §6.3.

### 6.2 Authentication

SDKs put the credential in provider-specific headers, so the relay extracted
the JWT/CI token from `Authorization: Bearer` **or** `x-api-key` (Anthropic
SDK) **or** `x-goog-api-key` (Google SDK), validated it itself, and swapped in
the real provider key. **This is why deployment MUST use `--no-verify-jwt`**
(§9). `resolveRelayCredential` (attic `_shared/relayCiToken.ts`) accepted a
user JWT (RLS-scoped profile client) or a CI token (hash lookup, revocation,
expiry, scope; service-role profile client).

### 6.3 Proxy enforcement order (as implemented; order was load-bearing)

1. Provider validated against `PROVIDER_CONFIGS` (9 providers with
   `baseUrl`/`envKey`/`authType`; see attic `models.ts`). Google
   generateContent paths 410'd (Interactions API only).
2. Credential extracted; 401 if missing.
3. Service-role enforcement client required **before** any authentication or
   key use — 503 `enforcementUnavailable` otherwise (public metadata routes
   stayed up).
4. Credential resolved (JWT or CI token) → `userId`.
5. Profile fetched (`tier`, `access_expires_at`, `banned_until`).
   **Ban checked first** (mirror of GoTrue `banned_until` via trigger, so a
   still-valid access token is cut off immediately), then access expiry
   (`access_expires_at` is a grant window — a future date GRANTS access; bans
   use GoTrue's native ban, never this column).
6. **Ultra-only providers**: openai/anthropic/google were relay-reachable only
   on Ultra (since 2026-07-14), gated on the **URL provider segment** so an
   unrecognized model string couldn't bypass it. 403 `providerRestricted`.
7. **Monthly spend** (`checkSpendingLimit`): RPC
   `get_user_monthly_relay_spend(p_user_id, p_month_start)` against the
   usage-log aggregate; soft limit (async logging means concurrent requests
   can pass before costs land). Unavailable ≠ allowed: RPC failure → 503, over
   limit → 429 `limitReached` with spend numbers.
8. Free-tier request-body cap 2 MiB (streamed count, aborts at limit) → 413.
9. Model extracted from JSON body `model` field or path
   (`/models/{model}:…`); retired models 403'd for every tier (denial guard
   built from llm-zoo `retired`, including fullName/openrouter aliases).
10. **Tier model check** (`isModelAllowedForTier`): Ultra → everything; Max →
    any explicit model (Ultra-only enforcement already happened at the
    provider segment); free → the model must resolve (longest-boundary-prefix
    match, provider-prefix stripped) to an llm-zoo entry within the free price
    ceiling. Denials suggested a usable model (`deepseek`), not just an
    upsell.
11. **Server-side reasoning cap** (mirror of §4.6) and free-tier
    `max_output_tokens` clamp (8192).
12. **Per-user request gate** (`acquireRelayRequestSlot`): DB-backed
    rate + concurrency slots via RPCs `relay_request_gate` /
    `relay_request_release` / `relay_request_refresh`; limits per tier — free
    20/min + 4 concurrent, Max 60/8, Ultra 120/16. Placed after validation so
    rejected requests never consume slots. Streaming responses held the slot
    until stream close with a 60 s lease refresh; a lost lease errored the
    stream and cancelled upstream. 429 with `retryAfterSeconds`.
13. Forward: hop-by-hop/auth headers stripped (attic `index.ts`
    `SKIP_REQUEST_HEADERS`), provider auth re-added per `authType` (`bearer` /
    `x-api-key` + `anthropic-version` default / `x-goog-api-key`), 390 s
    upstream timeout (Supabase 400 s wall clock), response streamed back with
    `X-Accel-Buffering: no` and an `x-relay-request-id` header; structured
    failure logging by phase (`classifyPreHeaderFailure`,
    `logRelayFailure`).

### 6.4 Error envelope

`{type: 'error', error: {_relay: <version>, type: 'relay_error', message,
…extra}}` — compatible with both OpenAI and Anthropic SDK error parsing; the
`_relay` marker is what client-side `isRelayError` keyed on. Distinguishing
`extra` fields: `banned`, `expired`, `providerRestricted`, `limitReached`,
`requestTooLarge`, `requestLimitReached` (reason `rate`/`concurrency`),
`spendCheckFailed`, `enforcementUnavailable`, `invalidRequestBody`.

### 6.5 Tier/model configuration (attic `models.ts`)

Single source of truth was the **llm-zoo** package: tier assignment derived
from pricing — free requires input ≤ $1.5/M **AND** output ≤ $9/M (the AND
closed a cheap-input/expensive-output loophole: gemini-pro at $2/$12, gpt-5 at
$1.25/$10 must not ride in on input price). Max = every relay model outside
Ultra-only providers; Ultra = `'*'`. Excluded: openRouterOnly, retired, and
Kimi-Code-pinned models (relay forwarded with an open-platform Moonshot key
and must not advertise coding-endpoint models). Spending limits: free $10,
Max $50, Ultra $300 — duplicated client-side in `src/auth/config.ts`
(`getRelaySpendingLimit`, prefault-to-free: absent tier = free, present
malformed tier = validation failure, i.e. accounting corruption stays loud).

### 6.6 Database requirements

- `profiles`: `tier` text ('Ultra'|'Max'|'free'), `access_expires_at`
  timestamptz (null = lifetime), `banned_until` (trigger mirror of
  `auth.users.banned_until`). All server-managed; clients SELECT only.
- `relay_ci_tokens`: service-role only; hash-at-rest tokens (§4.4).
- Usage aggregate RPCs from migrations `20260517100000_usage_logs_upsert_rpc.sql`
  and `20260517100100_usage_logs_aggregate_per_stream.sql`; request-gate RPCs
  (`relay_request_gate`/`release`/`refresh`) and their slot table.
- Grant time-limited access:
  `UPDATE profiles SET access_expires_at = NOW() + INTERVAL '90 days' WHERE user_id = …`
  (service role). Ban via GoTrue admin API (`ban_duration`), never via
  `access_expires_at`.

## 7. Telemetry coupling

`log-usage` (kept) accepted the CI relay token as an auth credential (removed
with the tokens; unauthenticated CI runs simply don't log usage) and its
validation still **tolerates** `route: 'relay'` / `usedRelay` from old
clients. Client `UsageLogService` (kept) stamped `usedRelay` and the `'relay'`
usage route on relay-served requests — production removed, wire tolerance
retained until old clients age out.

## 8. UI surfaces (as they existed; all removed)

- **Extension Settings → Account:** "Use included access" / "Use your own API
  keys" picker; `RelayQuotaMeter` (monthly spend bar, 80 % warning, exhausted
  state with "switch to your own keys or wait until next month" copy); tier
  shown in sign-in toast.
- **Model pickers** (extension + CLI): relay-availability filtering — models
  the tier covered showed as available without a key warning.
- **CLI:** `--api-mode included|relay|personal|byok` root flag, `/api-mode`
  slash command, "Included" status-bar badge with quota warning states,
  onboarding step offering included access, `texra setup-token` /
  `texra auth token`, doctor/api-status credential lines.
- **Desktop:** onboarding step + IPC mirroring the extension picker.
- **Progress view:** retry-request panel offered "retry with your own API
  key" on relay-limit exhaustion (subscription-quota version survives).
- **Quota auto-switch UX:** the flip was always visible in Settings; error
  copy (`INCLUDED_ACCESS.usedUp`) named both ways out.

## 9. Deploy gotchas (CRITICAL for any recovery)

- **`--no-verify-jwt` is mandatory** for `relay` (and any function that reads
  credentials from non-`Authorization` headers). A plain
  `supabase functions deploy relay` re-enables gateway JWT verification; the
  gateway then 401s every request whose JWT rides in `x-api-key` /
  `x-goog-api-key` — i.e. **anthropic/google break while openai/deepseek keep
  working**, which is exactly the confusing partial outage we hit in
  production. A fast ~70 ms 401 is the gateway, not the relay. The attic
  `deploy-relay.mjs` encodes the flag and refuses to run without
  `SUPABASE_PROJECT_REF`.
- `supabase secrets set` must also pass `--project-ref` — otherwise it targets
  whatever project the checkout happens to have linked, silently landing keys
  on the wrong project.
- Secrets changes restart the function (provider list is computed at cold
  start — that's fine).
- Full setup walkthrough: attic `docs/RELAY_SETUP.md`; endpoint reference:
  attic `docs/relay-tier-config.md`.

## 10. Cross-boundary parity (things that MUST stay in sync on recovery)

Deno edge functions cannot import client TypeScript, so these were duplicated
and pinned by `RelaySharedConfigParity.vitest.ts` (attic copy):

| Contract | Client side | Server side |
| --- | --- | --- |
| Tier names `free`/`Max`/`Ultra` | `src/auth/config.ts` `UserTierSchema` | `models.ts` tier constants + DB `profiles.tier` |
| Spending limits 10/50/300 | `getRelaySpendingLimit` | `TIER_SPENDING_LIMITS` |
| CI token prefix `texra_relay_` | `src/auth/relayToken.ts` | `_shared/relayCiToken.ts` |
| Relay URL shape `/functions/v1/relay/<provider><suffix>` | `ServerSideKeyService.getRelayBaseUrl` | Hono routes + `paths.ts` |
| GPT-5 effort caps free→medium, Max→high | `capIncludedReasoningEffort` | `reasoning.ts` + `OPENAI_GPT5_REASONING_EFFORT_CAPS` |
| Error marker `_relay` | `isRelayError` | `jsonError` envelope |

## 11. Sunset record (fill in as executed)

1. ☐ Tier-config provider list emptied for all tiers (date: ______). Old
   released clients deny included access client-side
   (`ServerSideKeyService` requires `providers.length > 0`) and fall back to
   own API keys within the 5-minute cache TTL. Left in place permanently.
2. ☐ Relay traffic monitored to ~0 (date: ______).
3. ☐ `supabase functions delete relay` / `relay-tokens` (date: ______).
4. ☐ Server-held provider API keys revoked at each provider console and
   `supabase secrets unset` (date: ______).
5. Kept deployed: `log-usage`, `auth-github`, `auth-device`, `auth-bridge`,
   `get-agent-config`, `before-user-created`, `github-app-token-exchange`.
6. ☐ Optional: `relay_ci_tokens` table dropped. `profiles.tier` left intact.

## 12. Rebuild recipe

1. Re-land the seam: restore `src/model/includedModelAccess.ts` and
   `src/controllers/modelAccess/installTexraModelAccess.ts` from the
   pre-removal SHA; re-wire the three host composition roots.
2. Restore `src/auth/serverKeys/`, `src/auth/relayToken.ts`, and the relay
   constants in `src/auth/config.ts` + `SupabaseClient` relay methods.
3. Re-add the call-site branches (the SHA's `ModelHandler`,
   `ModelInvocationNode`, `ProxyConfigResolver`, `computeModelOptions` show
   exactly where) and the UI surfaces per §8 as desired.
4. Copy `attic/supabase-relay/functions/*` back under `supabase/functions/`
   (the `_shared` relative imports resolve again), restore
   `scripts/deploy-relay.mjs`, re-create DB objects per §6.6.
5. Set provider secrets; deploy **with `--no-verify-jwt`** (§9).
6. Re-instate the parity suite from `attic/supabase-relay/tests/` and the
   `'relay'` producers on the usage route.
