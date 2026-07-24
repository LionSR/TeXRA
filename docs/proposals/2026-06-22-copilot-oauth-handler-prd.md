# PRD: GitHub Copilot model handler via OAuth (reverse-engineered API)

**Status:** Proposal — **EXPERIMENTAL / PARKED** (pending an explicit ToS-risk
decision by the maintainer)
**Owner:** _unassigned_
**Tracking branch:** `claude/vscode-copilot-handler-scout-ygc444`
**Companion proposal:** [`2026-06-22-copilot-vscode-lm-handler-prd.md`](./2026-06-22-copilot-vscode-lm-handler-prd.md) (the official, VS Code-only route)
**Closest existing precedent in this repo:** [`2026-06-21-chatgpt-subscription-codex-auth.md`](./2026-06-21-chatgpt-subscription-codex-auth.md) — structurally near-identical (borrowed client id, unofficial endpoint, OpenAI-shaped backend).

> **⚠️ Parked.** This route is reverse-engineered and runs against GitHub's
> Copilot Terms / Acceptable Use Policy, with **documented account-suspension
> risk**. It is written up for completeness and because it is the only route that
> works across **all three hosts** (extension + CLI + desktop), but it is **not
> approved for implementation** until the maintainer decides to accept the ToS
> risk. Do not start building from this PRD without that sign-off.

## Summary

Let a user sign in with their **own GitHub Copilot subscription** via GitHub's
OAuth **device flow**, then route TeXRA agent requests to the **undocumented
Copilot chat backend** (`https://api.githubcopilot.com/chat/completions`), which
is **OpenAI-Chat-Completions-compatible**. Unlike the
[`vscode.lm` route](./2026-06-22-copilot-vscode-lm-handler-prd.md), this works in the CLI and
desktop shell too, and slots directly into TeXRA's existing OpenAI-compatible
handler family (the same pattern as DeepSeek/Kimi/MiniMax/GLM).

It rides a **borrowed first-party client id** and editor-impersonation headers,
so it can break without notice and **must never be presented as a GitHub-
sanctioned integration** — exactly the framing already used for the Codex
(ChatGPT-subscription) handler.

## Motivation

- The only way to reach the user's Copilot subscription **outside VS Code** —
  preserves TeXRA's CLI/desktop parity (which `CLAUDE.md` treats as sacred),
  which the official `vscode.lm` route cannot.
- OpenAI-compatible → reuses the existing OpenAI handler machinery; the new work
  is auth + endpoint + headers + model registry (same delta as Codex).
- The `ModelProvider.COPILOT` slot is **already stubbed** (see Current state).

## Current state (verified in repo)

Same pre-reserved, inert slot the official route would also use:

| File                                                     | Line | State                                                             |
| -------------------------------------------------------- | ---- | ----------------------------------------------------------------- |
| `src/agent/runtime/ModelFactory.ts`                      | 122  | `[ModelProvider.COPILOT]: { load: null, compatibilityKey: null }` |
| `src/shared/constants/providers.ts`                      | 88   | display name `'Copilot'`                                          |
| `src/agent/modelHandlers/support/ProxyConfigResolver.ts` | 48   | `null`                                                            |

> Note: only **one** of the two Copilot routes can own the `COPILOT` provider id
> at a time. If both ship, they need distinct ids (e.g. `copilot` for OAuth vs
> `copilot-vscode` for the host route), decided at design time.

## Capability comparison against `vscode.lm`

| Capability      | OAuth backend route                                      | `vscode.lm` route                                      |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| Hosts           | Extension, CLI, desktop                                  | VS Code extension host only                            |
| API shape       | OpenAI Chat Completions-compatible backend               | VS Code Language Model API                             |
| System guidance | Native OpenAI-style system/developer messages expected   | Folded into user messages; no stable system role       |
| Image/PDF input | Potentially available later via Copilot vision headers   | Not available in stable `vscode.lm@1.105`              |
| Usage reporting | Backend may expose OpenAI-style token usage              | No returned usage; only `countTokens()` estimates      |
| Policy posture  | Reverse-engineered and parked behind maintainer go/no-go | Official API, still rate-limited for agentic workloads |

## Prior art (verified against source, not blog posts)

|                 | ericc-ch/copilot-api                                   | LiteLLM `github_copilot`           | CopilotChat.nvim | Zed                                               |
| --------------- | ------------------------------------------------------ | ---------------------------------- | ---------------- | ------------------------------------------------- |
| OAuth client id | `Iv1.b507a08c87ecfe98`                                 | `Iv1.b507a08c87ecfe98` (identical) | (LSP-delegated)  | (LSP-delegated)                                   |
| Device-code URL | `https://github.com/login/device/code`                 | same                               | via official LSP | via official LSP                                  |
| Token exchange  | `GET https://api.github.com/copilot_internal/v2/token` | same                               | same             | same                                              |
| Chat endpoint   | `https://api.githubcopilot.com/chat/completions`       | same                               | same             | `https://api.githubcopilot.com/chat/completions`  |
| Models endpoint | `…/models`                                             | `…/models`                         | `…/models`       | `https://api.individual.githubcopilot.com/models` |
| Scope           | `read:user`                                            | `read:user`                        | —                | —                                                 |

**The two-step token flow:** device flow → GitHub OAuth token (`gho_`/`ghu_`) →
`GET copilot_internal/v2/token` → short-lived Copilot session token
(`{ token, expires_at, refresh_in }`, auto-refreshed). Business/Enterprise use
`api.business.` / `api.enterprise.` hosts and _require_ the exchange step.

**Required impersonation headers** (the backend gates on these — missing
`Editor-Version` → hard `400 missing Editor-Version header for IDE auth`):
`Authorization: Bearer <copilot_token>`, `Copilot-Integration-Id: vscode-chat`,
`Editor-Version: vscode/<ver>`, `Editor-Plugin-Version`, `User-Agent:
GitHubCopilotChat/<ver>`, `X-GitHub-Api-Version: <date>`, `X-Request-Id`, and
conditionally `Copilot-Vision-Request: true`.

`https://api.githubcopilot.com/chat/completions` is OpenAI-compatible: `POST
/chat/completions`, `GET /models`, SSE streaming, and `tools` / `tool_calls`.

Evidence: ericc-ch `src/lib/api-config.ts` (client id, headers, base),
`src/services/github/get-copilot-token.ts` (exchange),
`src/services/copilot/create-chat-completions.ts` (stream + tools + `X-Initiator`
header); LiteLLM `litellm/llms/github_copilot/authenticator.py`; Zed
`crates/copilot/src/copilot_chat.rs`.

## Risk & policy (the reason this is parked)

- **GitHub Copilot Extension Developer Policy** prohibits, verbatim, "Bypass or
  circumvent protocols and access controls," "Use unpublished APIs," and "Attempt
  to reverse engineer … the Platform." This route does all three.
- **Usage-limits / AUP** enumerate scripted/automated use, proxy use, and
  excessive activity as restricted; Copilot use is explicitly subject to the AUP.
- **Real enforcement, quoted from GitHub notices:** abuse-detection warnings
  ("use of Copilot via scripted interactions … could result in a temporary
  suspension of your Copilot access") and account-disable notices ("We will not
  be able to reinstate your Copilot access").
- **Model parity is not guaranteed:** the public `…/models` set is a plan-gated,
  server-side allowlist that lags the in-editor catalog (community reports of
  GPT-5.x/Claude/Gemini missing from the API for some plans while present in
  Chat).
- **Header gating is the live breakage vector:** GitHub rejects requests lacking
  IDE-identifying headers, so the integration must keep impersonating editor
  versions/integration ids — a moving target.

Framing contrast in the wild: ericc-ch/copilot-api warns explicitly about ban
risk; aider's docs claim it's allowed. Neither is a GitHub guarantee. Treat as
**reverse-engineering under tacit tolerance**, like the Codex handler.

## Design (if/when unparked)

Mirrors the Codex proposal almost 1:1; the GitHub flow is actually _simpler_
(standard device flow, no PKCE/loopback strictly needed).

### 1. Provider id

A distinct OAuth-credentialed provider. **Do not** add it to `API_PROVIDERS` in
`src/model/apiProviders.ts` (which aliases `API_KEY_PROVIDER_IDS` from
`@shared/constants/apiKeyProviders`) — membership there wires an api-key field +
`<PROVIDER>_API_KEY` env fallback. Model the credential as an OAuth
token bundle with its own lookup + "Signed in as <login>" status, exactly as the
Codex proposal specifies for its non-api-key origin.

### 2. Auth coordinator (`src/auth/copilot/`)

Port the Codex coordinator shape:

- **Device flow:** `POST https://github.com/login/device/code` (client id
  `Iv1.b507a08c87ecfe98`, scope `read:user`) → display user code → poll
  `https://github.com/login/oauth/access_token` with
  `grant_type=urn:ietf:params:oauth:grant-type:device_code` → GitHub OAuth
  token.
- **Copilot token exchange:** `GET https://api.github.com/copilot_internal/v2/token` →
  short-lived Copilot token; refresh within the `refresh_in`/expiry window.
- **Account type:** detect individual vs business/enterprise to pick the right
  `api.*.githubcopilot.com` host.
- **Storage:** persist the bundle via `platform().secrets` under a Copilot-
  specific key **outside** the `apiKey.*` namespace (same isolation rule as
  `CODEX_SESSION_SECRET_KEY`).
- Keep **all** magic constants (client id, endpoints, header values, api-version
  date) in one `copilotConstants.ts` so a GitHub change is a one-file edit, with
  the same "unofficial / can be revoked" docblock as `codexConstants.ts`.

### 3. Model handler

`ModelHandlerCopilot` subclassing the OpenAI handler (like `ModelHandlerDeepSeek`):

- `getClient()` → `new OpenAI({ apiKey: copilotToken, baseURL: 'https://api.githubcopilot.com' })`;
  recreate / use a token-getter on refresh.
- Inject the impersonation headers via `defaultHeaders` (or a `fetch` wrapper for
  per-request freshness): `Copilot-Integration-Id: vscode-chat`,
  `Editor-Version`, `Editor-Plugin-Version`, `User-Agent`, `X-GitHub-Api-Version`.
- Bearer comes from the auth coordinator, **not** `getApiKey()`.
- Streaming + tool calls reuse the OpenAI handler paths unchanged.

### 4. Model registry & pricing

- v0: hardcode a curated, refreshable set; later add dynamic `GET /models`
  discovery (the allowlist lags and is plan-dependent).
- Cost is **subscription-included / premium-request metered**, not $/token —
  surface as "included in your Copilot plan (rate-limited)"; handle 401/403
  (model above tier, or abuse-block) with a clear, actionable error.

### 5. Cross-host

Works in extension, CLI, and desktop. Device flow is TTY/headless-friendly
(matches `texra`'s existing `auth` command pattern from the Codex work).

## ToS / framing (non-negotiable, if unparked)

- **Opt-in only**, off by default, behind an experimental flag, labeled clearly:
  "use your **own** Copilot subscription, personal use, unofficial, may break,
  may trigger GitHub abuse detection."
- Use the user's own signed-in session only — never share/relay tokens.
- Document the suspension risk in-product before first use (a one-time
  acknowledgement), mirroring the honesty bar set by the Codex feature.
- Tokens in the OS keychain via `platform().secrets`; never logged or synced.

## Scope (if unparked)

**In (v0):** device-flow login + two-step token exchange + refresh; OAuth-
credentialed provider id; OpenAI-handler subclass with impersonation headers;
curated model registry; Settings + CLI sign-in; experimental flag + risk
acknowledgement; docs.

**Out (v0):** dynamic `/models` discovery; Business/Enterprise SSO edge cases;
image/vision (`Copilot-Vision-Request`) until base flow proven; any
shared/server/multi-account deployment (an explicit AUP violation).

## Open questions

1. **Go/no-go on the ToS risk** — the gating decision; everything below is moot
   until resolved.
2. Provider id coexistence with the official route (`copilot` vs
   `copilot-vscode`).
3. Whether to borrow `Iv1.b507a08c87ecfe98` (works today, fragile) — isolate it
   so it can be swapped if GitHub ever ships a sanctioned client id.
4. How aggressively to throttle client-side to stay under abuse-detection
   thresholds (TeXRA agent runs are exactly the "strenuous/scripted" pattern
   GitHub flags).
5. Representing subscription/premium-request "pricing" in usage/telemetry that
   assumes $/token (shared with Codex/`vscode.lm` work).

## Rollout (only after go decision)

1. Constants + auth coordinator + token storage (no UI), with unit tests for
   device flow, token exchange, and refresh.
2. OpenAI-handler subclass; verify a live streamed `…/chat/completions` call with
   tools against a real account.
3. Settings + CLI sign-in behind the experimental flag + one-time risk
   acknowledgement.
4. Curated model registry; CHANGELOG under an "Experimental" heading.

## References

- ericc-ch/copilot-api: https://github.com/ericc-ch/copilot-api
  (`src/lib/api-config.ts`, `src/services/github/get-copilot-token.ts`,
  `src/services/copilot/create-chat-completions.ts`)
- LiteLLM provider: https://docs.litellm.ai/docs/providers/github_copilot
  (`litellm/llms/github_copilot/authenticator.py`)
- CopilotChat.nvim providers:
  https://github.com/CopilotC-Nvim/CopilotChat.nvim (`lua/CopilotChat/config/providers.lua`)
- Zed: `crates/copilot/src/copilot_chat.rs`;
  https://github.com/zed-industries/zed/issues/22901
- aider Copilot docs: https://aider.chat/docs/llms/github.html
- Copilot Extension Developer Policy:
  https://docs.github.com/en/site-policy/github-terms/github-copilot-extension-developer-policy
- Copilot usage limits: https://docs.github.com/en/copilot/concepts/usage-limits
- Enforcement notices (quoted by recipients):
  https://github.com/orgs/community/discussions/160013 ,
  https://github.com/orgs/community/discussions/174325
- In-repo precedent: [`2026-06-21-chatgpt-subscription-codex-auth.md`](./2026-06-21-chatgpt-subscription-codex-auth.md)
