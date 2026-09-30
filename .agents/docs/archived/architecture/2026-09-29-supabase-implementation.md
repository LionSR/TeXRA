# The Supabase implementation, as of sign-in removal

Status: archived — record of TeXRA's hosted account (Supabase) integration,
written before sign-in leaves the three hosts
Archived: 2026-09-29

**Reference commit:** `98aa293907e17ace52e4f6548e7b2c7f0c466ad5` (`main`,
2026-09-29). Every `path:line` below is at that commit; `git show
98aa293907:<path>` recovers any client file after the removal lands.

The owner ruled on 2026-09-29 that sign-in leaves the VS Code extension, the
desktop app and the CLI. Everything works with the user's own keys and
provider subscriptions, and offline use needs no account. The hosted service
stays up until its sunset date, because released versions (through `v0.40.10`
/ `cli-v0.40.10`) still call it. This note records what the integration does,
so it can be rebuilt. It is history, not current design.

Related records: the relay removal
([2026-08-18](../simplification/2026-08-18-relay-removal-and-recovery.md),
server sources in `attic/supabase-relay/`) and the remote-agents removal
(#13442), which already took the hosted agent catalog out of the client.

## 1. What the account was for at the reference commit

After the relay (2026-08) and remote agents (#13442) left the client, a TeXRA
account gated only two things:

1. **Usage telemetry delivery.** `UsageLogService` sends batches only with a
   signed-in access token (section 4). A signed-out install queues entries and
   never sends them.
2. **Account status surfaces.** Each host shows signed-in or signed-out, the
   account label, and an expired/unavailable problem. None of them gates a
   model call, an agent, or a tool.

The setup tools say so explicitly: `src/tools/setup/VerifySetupTool.ts:110-118`
does not count a bare sign-in as a usable model credential.

## 2. Client configuration

All in `src/auth/config.ts`:

| Name                          | Line | Value / meaning                                                                                                                                                                 |
| ----------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_CUSTOM_DOMAIN`      | 25   | `remote.texra.ai`, the custom domain in front of the Supabase project                                                                                                           |
| `SUPABASE_CONFIG`             | 27   | `url: https://remote.texra.ai`, `publicKey`: the project's **publishable** key (`sb_publishable_…`). It is public by design; RLS protects data. Its value is not repeated here. |
| `DEVICE_AUTH_BASE_URL`        | 39   | `https://remote.texra.ai/functions/v1/auth-device`                                                                                                                              |
| `AUTH_BRIDGE_URL`             | 55   | `https://remote.texra.ai/functions/v1/auth-bridge`                                                                                                                              |
| `OAUTH_PROVIDERS`             | 61   | `['github', 'google']`; labels at 65; `DEFAULT_OAUTH_PROVIDER = 'github'` at 83                                                                                                 |
| `EXTENSION_ID`                | 92   | `texra-ai.texra`, overridden at activation by `setRuntimeExtensionId` (105)                                                                                                     |
| `getAuthCallbackUri(scheme)`  | 125  | `${scheme}://${extensionId}/auth-callback`                                                                                                                                      |
| `AUTH_CALLBACK_TIMEOUT_MS`    | 140  | 10 minutes, the browser round-trip deadline for every host                                                                                                                      |
| `TOKEN_REFRESH_THRESHOLD_MS`  | 143  | 30 minutes: refresh proactively inside this window                                                                                                                              |
| `SUPABASE_SESSION_KEY`        | 146  | `texra.supabase.session`, the host secret-store key of the session record                                                                                                       |
| `SUPABASE_GOTRUE_STORAGE_KEY` | 154  | `texra.supabase.gotrue`, GoTrue's pinned storage key (PKCE flow state is derived from it)                                                                                       |

`src/auth/constants.ts:8-15`: the VS Code auth provider id `texra-supabase`
and the commands `texra.auth.signIn`, `texra.auth.signOut`,
`texra.auth.viewProfile`. The client dependency is `@supabase/supabase-js`
(catalog pin `2.117.2`, `pnpm-workspace.yaml:18`; consumed at
`package.json:116` and `packages/agent/package.json:58`).

Server-side names (values are secrets or project settings and are not
recorded here):

- Edge function environment: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (`supabase/functions/_shared/edgeClients.ts:12-14`),
  `BEFORE_USER_CREATED_HOOK_SECRET` (format `v1,whsec_<base64>`,
  `supabase/functions/before-user-created/index.ts:7-10,24-26`),
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
  (`supabase/functions/github-app-token-exchange/index.ts:43-48`).
- Catalog sync: the script reads `SUPABASE_DB_URL` and `SUPABASE_PROJECT_REF`
  (passed to the CLI as `SUPABASE_PROJECT_ID`)
  (`scripts/sync-remote-agents.mjs:266-305`). The workflow
  `.github/workflows/remote-agents-sync.yml` supplies the secret
  `SUPABASE_ACCESS_TOKEN`, which the Supabase CLI reads from the environment
  (the script never names it), and the repository variable
  `SUPABASE_PROJECT_REF`.
- `TEXRA_REMOTE_AGENTS_ROOT` overrides the catalog root for the sync script
  (`scripts/sync-remote-agents.mjs:29`).
- The project ref itself lives in the GitHub repository variable and in a
  linked checkout's `supabase/.temp/project-ref` (git-ignored,
  `.gitignore:29`). It is not in the tree.

## 3. Authentication

### 3.1 The shared core (`src/auth/`, `src/controllers/auth/`)

**The account plane.** `createSupabaseAuth` (`src/auth/SupabaseAuth.ts:188-301`)
builds one GoTrue client per process with `createClient(url, publicKey, …)`
(202). Its options:

- `flowType: 'pkce'` (219) and `detectSessionInUrl: false` (220). Browser
  OAuth returns a one-time `?code=` and never tokens; every host parses its
  own callback and calls `exchangeCodeForSession`.
- `autoRefreshToken: false` (213). Refresh is manual (below).
- `persistSession: true` with a custom `storage` (210-212). The adapter,
  `gotrueStorage` (55-110), writes only PKCE flow state (the
  `-code-verifier` keys derived from `texra.supabase.gotrue`) to the host
  secret store, mirrored in memory. The bare session slot stays in memory, so
  the host's own session record is the single owner of the session. PKCE state
  in the secret store is what lets a callback that lands in another editor
  window, or after a reload, finish the exchange.

The plane is served as the Effect service `SupabaseAuth`
(`src/auth/SupabaseAuth.ts:170-177`) through `installProcessRuntime`'s `auth`
option (`src/platform/processRuntime.ts:23,87`;
`src/controllers/session/sessionLayer.ts:1115`). Its shape (130-162) exposes
`client`, `coordinator`, `isReady`, `accessToken`, `user`, `authenticated`,
`storedSessionState`, `storedAccountLabel` and the init-error pair.
`unavailableSupabaseAuth` (309-336) is the signed-out plane for a composition
without one; the SDK runtime uses it (`packages/agent/src/effect/runtime.ts:22,178`).

**Session record and refresh.** `SupabaseSessionCoordinator`
(`src/auth/SupabaseSession.ts:65-405`) owns the stored record. The schema is
`{ id, accessToken, refreshToken, account: { id, label }, expiresAt }`
(`src/auth/supabaseSessionTypes.ts:10-20`). `toStorableSupabaseSession`
(116-132) converts GoTrue's snake_case, seconds-based session and uses the
email (or the user id) as the label. It is stored as JSON under
`texra.supabase.session` through `secretBackedSessionStorage`
(`src/auth/SupabaseAuth.ts:226`, `src/auth/oauth/sessionAccess.ts`).

- `ensureFreshToken` (111-116) → `freshSession` (353-386): when the token
  expires within 30 minutes it refreshes proactively. If the refresh fails and
  the token is already expired, it returns null.
- `refreshSession` (273-291) is single-flight (`SharedAttempt`, detached so an
  interrupted caller cannot drop a rotated refresh token). It calls
  `client.auth.refreshSession({ refresh_token })` with a 30 s deadline
  (`REFRESH_TIMEOUT_MS`, 45; call at 300-316).
- Writes are serialized with a version counter (`SerializedWrites`,
  `src/auth/authProgram.ts:43-102`). A refresh that loses a race to a newer
  write does not overwrite it (325-346). `clearSessionIfCurrent` (100-104)
  clears only the credential pair the caller saw.
- Failure classification: HTTP 400/401 is `invalid`, anything else is
  `transient` (`src/auth/TokenProvider.ts:10-14`). `getStoredSessionState`
  answers `none | authenticated | invalid | transient` (388-404), so a GoTrue
  outage never reads as signed out.
- `exchangeCode` (229-264) maps `pkce_code_verifier_not_found` to a plain
  "this sign-in link is no longer valid" message.

**The sign-in state machine.** `SupabaseSignInCoordinator`
(`src/controllers/auth/supabaseSignIn.ts:144-495`) is shared by all three
hosts. A host supplies only an `AuthCallbackTransport` (84-106): `open`
(arm the callback route and return the redirect URL), `presentSignInUrl`,
and `announce` (word a callback nobody in this process is waiting for). One
attempt (`runAttempt`, 239-304):

1. Open the transport's route before anything else.
2. Wait for superseded commits and sweep stale pending records.
3. Call `client.auth.signInWithOAuth({ provider, options: { redirectTo,
queryParams } })` (256-266) under a process-wide PKCE permit (45).
4. Bind the returned `flowId` to the attempt's nonce in the pending store
   (`PendingOAuthStore.bind`, `src/controllers/auth/pendingOAuthStore.ts:76-98`).
5. Race `presentSignInUrl` against the callback, all under the 10-minute
   deadline (283-296).

A callback (`acceptCallback` → `processCallback`, 186-208, 306-372):

1. Claim the nonce: it must be one of ours, fresh, and bound to a flow.
   Claims are serialized so two windows cannot both commit (410-441).
2. Exchange the code with that flow's verifier.
3. Re-check ownership on the commit lane, then store the session.

Declining consent (`error=access_denied`) settles as `SignInCancelled`
(53-58, 375-402).

**Login CSRF.** Each attempt mints a 16-byte hex nonce (`mintCallbackNonce`,
`pendingOAuthStore.ts:168-172`). The callback URL carries it as `app_nonce`
(`withCallbackNonce`, 145-148), and exactly one well-formed value must come
back (`callbackNonce`, 138-142). The pending record schema is
`{ nonce, createdAt, flowId? }` (`src/auth/pendingOAuthState.ts:22-29`); a
record is fresh for 10 minutes and never if stamped in the future (38-43).
Callback parsing: `src/auth/authCallback.ts` accepts the paths
`/auth-callback` and `/extension-auth-callback` (1-4) and reads `code` or
`error`/`error_description` (38-61).

**Providers and flows.** GitHub and Google OAuth through GoTrue, both PKCE.
There is no email or password sign-in, and no magic link in the client. The
server enables email (`/auth/v1/settings` reports `email: true`), and
`AUTH_OPERATIONS.md` covers the email sign-up and recovery mailer. Magic
links appear only server-side, as the mechanism `auth-device` uses to mint a
session (3.4). Account selection: the CLI passes `prompt=select_account`
(Google) and `login`/`login_hint` (`packages/cli/src/runtime/supabaseAuth.ts:138-151`).

### 3.2 Redirect URIs

The Supabase Auth "Redirect URLs" allow-list (Dashboard → Authentication →
URL Configuration) must hold:

- `https://remote.texra.ai/functions/v1/auth-bridge**`. The globstar spans
  `/<scheme>/<extension-id>/<nonce>`, which a single `*` cannot
  (`src/auth/config.ts:41-55`; `supabase/functions/auth-bridge/index.ts:35-40`).
  Desktop VS Code-family editors redirect here.
- Editor deep links `vscode://texra-ai.texra/auth-callback`,
  `vscode-insiders://…`, `cursor://…`, `windsurf://…`, plus web workbench
  wildcards `https://*.github.dev/**`, `https://*.gitpod.io/**`,
  `https://vscode.dev/**`, `https://*.vscode.dev/**`
  (`docs/supabase/SUPABASE_SETUP.md`, Part 2). The web workbench redirects
  straight to `asExternalUri(...)`.
- The desktop app's own scheme, `texra://texra-ai.texra/auth-callback?app_nonce=…`
  (`packages/desktop/src/main/desktopSupabaseAuth.ts:188-191`; scheme
  registered in `packages/desktop/electron-builder.yml:7-10`).
- CLI loopback `http://127.0.0.1:<port>/auth-callback?app_nonce=…`
  (`packages/cli/src/runtime/supabaseAuthCallbackServer.ts:36-37,62-66`).
- `https://remote.texra.ai/functions/v1/auth-device/verify`, the device
  verification page (`supabase/functions/auth-device/index.ts:26-27`).

OAuth apps: a GitHub OAuth App and a Google OAuth client, both with the
callback `https://<project>.supabase.co/auth/v1/callback`
(`docs/supabase/SUPABASE_SETUP.md`, Part 2). The Google app must be "In
production", not "Testing" (`docs/supabase/AUTH_OPERATIONS.md`).

### 3.3 Token storage per host

| Host      | Secret store                                                                     | Session record           | Pending sign-in records                                                                                                             |
| --------- | -------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Extension | VS Code `SecretStorage`                                                          | `texra.supabase.session` | one secret per nonce, `texra.auth.pendingOAuthState.<nonce>` (`packages/extension/src/frontend/auth/SupabaseAuthProvider.ts:56-70`) |
| Desktop   | Electron `safeStorage` (`packages/desktop/src/main/platform/electronSecrets.ts`) | `texra.supabase.session` | one state-store JSON object under `texra.desktop.pendingOAuthState` (`packages/desktop/src/main/desktopSupabaseAuth.ts:35,81-113`)  |
| CLI       | `<storageRoot>/secrets.json` (`packages/cli/src/runtime/cliSecrets.ts:138`)      | `texra.supabase.session` | in memory for the life of one process (`memoryPendingOAuthSlots`, `pendingOAuthStore.ts:151-165`)                                   |

PKCE verifier slots live in the same secret store under keys derived from
`texra.supabase.gotrue`.

### 3.4 How each host triggers sign-in

**VS Code extension.**

- Composition: `createSupabaseAuth` at activation, degrading to
  `unavailableSupabaseAuth` on failure (`packages/extension/src/extension.ts:189-199`).
  `registerSupabaseAuth` (362-422) registers a `vscode.AuthenticationProvider`
  with id `texra-supabase`, label "TeXRA Account" (392-399; contributed at
  `packages/extension/package.json:31-36`), and a `vscode.UriHandler`
  (`packages/extension/src/frontend/auth/UriHandler.ts`). It opens the
  readiness gate once the handler is installed (183-199, 401-407).
- Provider: `SupabaseAuthProvider`
  (`packages/extension/src/frontend/auth/SupabaseAuthProvider.ts:80-518`).
  `createSession` (346-362) reads `provider:<id>` from the scopes
  (`github-browser` maps to `github`). It runs the coordinator inside a
  cancellable progress notification (369-414). The callback URL is
  `AUTH_BRIDGE_URL/<uriScheme>/<extensionId>/<nonce>` on desktop, or
  `asExternalUri(getAuthCallbackUri(...))` plus `app_nonce` on the web
  workbench (297-338). `getSessions` validates the stored session with
  `client.auth.getUser(token)`, refreshing it if expired. An authoritatively
  invalid session is cleared and the user is prompted to sign in again
  (206-290; prompt text at `extension.ts:376-386`).
- Commands: `signIn` / `signOut` (`packages/extension/src/commands/auth/authCommands.ts:93-228`).
  The quick pick offers Google or GitHub (27-38), then calls
  `vscode.authentication.getSession(..., { createIfNone: true })`. The
  commands are registered through `packages/extension/src/commands/extensionCommandHandlers.ts:131-133`
  and the catalog (`src/shared/commands/catalog.ts:145-173`). The welcome
  path registers its own `texra.auth.signIn` (`extension.ts:488-490`).
- Entry points: the command palette; the welcome view's "Sign in to a TeXRA
  account" link (`packages/extension/src/frontend/ui/welcomeView.ts:37,140`);
  the settings Account tab (`packages/extension/src/settingsView/frontend/tabs/AccountTab.ts:52-100`,
  posting `SIGN_IN`/`SIGN_OUT`, handled at
  `packages/extension/src/settingsView/SettingsViewMessageHandler.ts:241-244`);
  and the setup agent's `invoke_command` allowlist
  (`src/tools/setup/InvokeCommandTool.ts:29-30,96`). Session changes repaint
  the progress and settings views through `onTexraAuthSessionsChanged`
  (`packages/extension/src/frontend/events/onTexraAuthSessionsChanged.ts`;
  `packages/extension/src/progressView/ProgressViewProvider.ts:423`,
  `packages/extension/src/settingsView/SettingsViewProvider.ts:76`).

**Desktop app.**

- Composition: `createSupabaseAuth({ secrets })` in the platform init
  (`packages/desktop/src/main/platform/index.ts:128`), served as `auth` (163).
  The pending store is opened before the first window, so a deep link that
  launched the app can still be claimed (`packages/desktop/src/main/index.ts:203-214`).
- Flow: `createDesktopSupabaseAuth`
  (`packages/desktop/src/main/desktopSupabaseAuth.ts:130-279`). The transport
  returns `texra://…/auth-callback?app_nonce=…` (188-191). It opens the
  system browser and shows "Complete sign-in in your browser" (192-198). The
  `texra://` protocol router delivers callbacks
  (`packages/desktop/src/main/desktopProtocolCallbacks.ts`). The attempt runs
  detached, and its outcome is reported by dialog (224-248).
- Provider choice: a native message box, "Sign in to TeXRA"
  (`packages/desktop/src/main/desktopOAuthProviderPrompt.ts:22-40`), owned by
  `openWindowAccount` (`packages/desktop/src/main/desktopWindowAccount.ts:107-123`).
- Entry points: the settings view's Sign in button
  (`packages/desktop/src/main/desktopSettingsIpc.ts:56-59,195-197`, rendering
  the shared Account tab) and the shell actions for the native menu and
  command palette (`packages/desktop/src/main/desktopShellIpc.ts:64,77,152`;
  wired at `packages/desktop/src/main/desktopWindow.ts:150-204`). The window
  navigation policy allows `*.texra.ai` for these flows
  (`packages/desktop/src/main/desktopNavigationPolicy.ts:14-15`).

**CLI.**

- Composition: `ensureCliSupabaseAuth(secrets)` at the root
  (`packages/cli/src/runtime/cliProcessRuntime.ts:206`;
  `packages/cli/src/runtime/supabaseAuth.ts:66-77`).
- Browser flow: `signInCliSupabase` (101-136) over the loopback transport. A
  `node:http` server listens on `127.0.0.1:0` for one attempt
  (`packages/cli/src/runtime/supabaseAuthCallbackServer.ts:52-77,92`). The
  GET serves a page that scrubs `?code=` from the address bar and history,
  then POSTs the query back (8-9, 118-123, 254). `--no-browser` prints the
  URL instead.
- Device flow (headless, SSH, WSL2): `signInCliSupabaseDeviceCode`
  (`packages/cli/src/runtime/supabaseAuth.ts:165-177`) posts
  `DEVICE_AUTH_BASE_URL/code`, then polls `/token` with RFC 8628 semantics
  (`authorization_pending`, `slow_down` +5 s, `access_denied`,
  `expired_token`) (`packages/cli/src/runtime/supabaseAuthDeviceCode.ts:80-224`).
  The result is a native GoTrue session, stored like any other
  (`GitHubTokenExchangeSchema`, `src/auth/supabaseSessionTypes.ts:23-39`;
  `completeDeviceSession`, `src/auth/oauth/deviceAuthorization.ts`).
- Commands: `texra login [github|google] [--no-browser] [--device]
[--select-account] [--login-hint]`, `texra logout`, and `texra auth
[status]` (`packages/cli/src/commands/auth.ts:185-351`; registered at
  `packages/cli/src/commands/root.ts:93-97`). `texra auth chatgpt|grok` are
  the subscription flows, not the TeXRA account. The TUI has `/login
[texra …]`, `/login status` and `/logout`
  (`packages/cli/src/chat/tui/commands/handlers/loginCommands.ts:51-54,105-116,174`),
  and there is an interactive provider picker
  (`packages/cli/src/commands/loginProviderPicker.tsx`).
- Status readers: `getCliAuthProfile` (`supabaseAuth.ts:196-226`), used by
  `texra doctor` (`packages/cli/src/commands/doctor.ts:60`;
  `packages/cli/src/runtime/doctor.ts:235`), the API status view
  (`packages/cli/src/runtime/apiStatus.ts:36,67,82,136`), and the account form
  (`packages/cli/src/runtime/modelAccessSelection.ts:96-104`;
  `packages/cli/src/runtime/modelAccessRoute.ts:49-54,249-254`;
  `packages/cli/src/chat/tui/forms/AccountAccessForm.tsx:154`).

**Shared status readers.**

- `SettingsProfileController.buildProfileMessage` builds the
  `UPDATE_PROFILE` message: `authenticated`, `user.email`, and
  `sessionProblem: 'expired' | 'unavailable'`
  (`src/controllers/settingsView/SettingsProfileController.ts:49-95`; schema
  `src/shared/settingsView/profileViewMessages.ts:57,67-70`).
- The setup tools' `getSetupAuthStatus` (`src/tools/setup/platform.ts:138-147`)
  feeds `ProbeEnvironmentTool.ts:143-171` and `VerifySetupTool.ts:110-118`.
- Copy: "TeXRA account" (`RESEARCHER_ACCESS`, `src/ui/copy/onboarding.ts:36-38`)
  and `RESEARCHER_ACCESS_AUTH` (`src/ui/copy/accountAuth.ts`).

Architecture fences that name this code:
`src/test-kernel/architecture/hostedAuthImportBoundary.vitest.ts` (keeps
`src/model` and `src/agent/{core,runtime}` off the hosted auth plane; only
`@auth/codex` and `@auth/xai` are allowed there).

## 4. Telemetry and usage logging

The only telemetry TeXRA sends is usage logging to Supabase. There is no
other analytics SDK, crash reporter or VS Code telemetry reporter in the tree.

**Producer.** `reportUsage` (`src/agent/runtime/run/modelCall.ts:88-130`)
runs once per priced model call, after the turn succeeds (241-247). It calls
`UsageLog.log(entry, config)`. `UsageLog` is a process service
(`src/shared/usageLog.ts:72-85`); `UsageLog.disabled` sends nothing and is
what the SDK runtime uses (`packages/agent/src/effect/runtime.ts:196`).

**Sender.** `usageLogLayer` (`src/telemetry/UsageLogService.ts:534-544`)
requires `HttpClient | SupabaseAuth`. Each host installs it with its version
and editor type:

- extension: `vscode.env.appName` (`packages/extension/src/extension.ts:231-234`)
- desktop: `packages/desktop/src/main/platform/index.ts:171`
- CLI: `'cli'` (`packages/cli/src/runtime/cliProcessRuntime.ts:248`)

Behavior:

- Queue up to 1000 entries, dropping the oldest (44, 239-243). Flush at 10
  entries or every 30 s on an unref'd timer (54-58, 201-211), and drain on
  scope close (216, 488-518).
- **Auth:** `sendNextBatch` reads `SupabaseAuth.accessToken`. With no token it
  logs "Skipping flush - user not authenticated" and sends nothing; the entries
  stay queued for the life of the process (319-328). With a token it POSTs
  `Authorization: Bearer <GoTrue access token>` (425-427).
- **Endpoint:** `https://remote.texra.ai/functions/v1/log-usage` (43). The
  request has a 10 s timeout, and the body read counts toward it (407-481).
- **Consent**, re-read at queue time and again at send time, per entry,
  against the workspace that recorded it (89-120, 344-363):
  - the environment opt-outs `TEXRA_NO_TELEMETRY` and `DO_NOT_TRACK` (68-74);
  - the setting `texra.telemetry.enabled`, default `true`
    (`src/shared/schemas/coreSettings.ts:26,42`;
    `src/shared/state/stateSettings.ts:589`). Either scope may opt out, and a
    non-boolean value counts as off.
- **Retry:** an undelivered batch keeps its `batchId` and is retried by the
  next trigger. A response with `success: false, retryable: false` is logged
  and discarded (384-400, 465-467). The acknowledgement must accept every
  entry (474-478).

**Payload** (`src/shared/usageLog.ts:8-53`):

```jsonc
{
  "batchId": "<uuid>",
  "entries": [
    {
      "timestamp": "<ISO-8601>",
      "model": "<full model name>",
      "provider": "<turn protocol, e.g. openai-responses>",
      "agentName": "…",
      "agentCategory": "workflow|toolUse",
      "usageRoute": "api-key|chatgpt-subscription|glm-coding-plan-subscription|kimi-code-subscription|xai-subscription",
      "streamId": "<run id>",
      "inputTokens": 0,
      "outputTokens": 0,
      "cost": 0.0,
      "responseTimeMs": 0,
      "cachedInputTokens": 0,
      "reasoningTokens": 0,
      "extensionVersion": "<host version>",
      "editorType": "cli|<editor>|desktop",
    },
  ],
}
```

No prompt text, file content, path or key is sent. The user is identified
only by the JWT's `sub` on the server.

**Server.** `supabase/functions/log-usage/index.ts`:

- Authenticates with `authenticateJwt` (`_shared/auth.ts:31-48`,
  `client.auth.getUser()`): a missing token is a 401 (220-223), an invalid one
  is a 401 (228-231). The user id is taken from the token (232).
- Validates the batch with `UsageBatchSchema`
  (`supabase/functions/log-usage/usageValidation.ts:26-71`). It still accepts
  the legacy relay fields `usageRoute: 'relay'` and `usedRelay` (owned by
  #10921) and `viaChatGptSubscription`.
- Routes subscription rounds to `subscription_usage_logs` with a `source`
  (`chatgpt|kimi|glm|grok`, 75-92). A zero cost there is replaced by the
  llm-zoo list-price equivalent (`equivalentCost.ts`; `index.ts:60-85`).
  Everything else goes to `usage_logs`.
- Writes through service-role RPCs `usage_logs_upsert` and
  `subscription_usage_logs_upsert` with `p_rows`. The rows aggregate per
  `(user_id, stream_id)` (178-188, 297-305). Dedup is best effort, by
  `(user_id, batch_id)` (159-176).
- Row columns (133-157): `user_id, logged_at, model, provider, agent_name,
agent_category, input_tokens, output_tokens, cost, response_time_ms,
cached_input_tokens, reasoning_tokens, used_relay, stream_id,
extension_version, editor_type, batch_id` (+ `source` for subscription
  rows).
- Response contract: see the header comment (14-24). Invalid batches get
  HTTP 200 with `success:false, retryable:false` until #6981.

**Consequence for sign-in removal.** No unauthenticated path to `log-usage`
exists. An anonymous POST gets 401. Anonymous GoTrue users are disabled on
the project: `GET https://remote.texra.ai/auth/v1/settings` reported
`"anonymous_users": false` on 2026-09-29, with `github`, `google` and `email`
enabled. Removing sign-in without a server change therefore silences
telemetry entirely. Section 8 names the smallest server change that keeps it.

## 5. Server side

### 5.1 Edge functions (`supabase/functions/`)

All are deployed with `--no-verify-jwt`; each verifies its own credential
(`docs/supabase/SUPABASE_SETUP.md`, Part 5). CI runs `deno check`, `deno lint`
and `deno test` for every function with a `deno.json`
(`.github/workflows/ci.yml:119-135`).

| Function                    | Auth                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-bridge`               | none                        | GET `/auth-bridge/<ext>/<id>/<nonce>` serves an HTML hand-off page. It rebuilds `<ext>://<id>/auth-callback?code=…&app_nonce=<nonce>`, auto-opens it, and keeps an "Open in editor" button. Exists because some browsers (Firefox on Linux) drop server redirects into custom schemes. Allowlisted schemes at `index.ts:48-60`; strict CSP; the code is scrubbed from history.                                                                                                                                                                                |
| `auth-device`               | mixed                       | RFC 8628 device authorization (Hono, `index.ts:79-433`). `POST /code` is anonymous: it mints a 32-byte device code (stored as a SHA-256 hash) and an 8-char user code, with a 15 min TTL and a 5 s interval. `GET /verify` is the browser page that signs in with the same OAuth and approves or denies. `POST /approve` needs a user JWT. `POST /token` is the poll, and mints a native GoTrue session by generating an admin magic link and consuming it server-side (`_shared/goTrueSession.ts:15-55`). Table `device_auth_requests` is service-role only. |
| `log-usage`                 | user JWT                    | Section 4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `get-agent-config`          | user JWT (RLS)              | `POST { agentName }`. Reads `remote_agents.storage_path` as the user, so RLS decides visibility. Downloads the YAML from the private `agent-configs` bucket with the service role and returns `{ config }`. Called only by released clients.                                                                                                                                                                                                                                                                                                                  |
| `before-user-created`       | Standard Webhooks signature | GoTrue "Before User Created" hook at `https://remote.texra.ai/functions/v1/before-user-created`. It blocks disposable or blocked email domains (`_shared/emailPolicy.ts`) and GitHub accounts younger than the policy age. It fails open when GitHub is unreachable, and allows users with no email, i.e. anonymous users (`index.ts:125-129`).                                                                                                                                                                                                               |
| `github-app-token-exchange` | GitHub Actions OIDC         | Exchanges a GitHub Actions OIDC token for a repo-scoped TeXRA GitHub App installation token. It has nothing to do with sign-in and deliberately does not import the Supabase client.                                                                                                                                                                                                                                                                                                                                                                          |

Shared helpers: `_shared/edgeClients.ts` (service-role `adminClient` and
`anonClient`), `_shared/auth.ts` (`bearerToken`, `authenticateJwt`),
`_shared/cors.ts`, `_shared/responses.ts`, `_shared/crypto.ts`,
`_shared/edgeMiddleware.ts`, `_shared/goTrueSession.ts`,
`_shared/emailPolicy.ts`.

### 5.2 Database, RLS and storage

The canonical migrations are **not in this repository**. They live in the
private infrastructure repository; `supabase/migrations/` has been untracked
since #9784 (`.gitignore:30`, `supabase/README.md`). What the tree shows:

- `profiles(user_id → auth.users, email, permissions text[], …)` is created
  by the `on_auth_user_created` trigger. The relay-era columns `tier`,
  `access_expires_at` and `banned_until` are still there (relay record §6.6).
  RLS: users read and update their own row.
- `remote_agents(id, name unique, description, storage_path, visibility
text[], agent_category, tools text[], …)`. RLS: visible when `'public' =
ANY(visibility)`, when `visibility && profiles.permissions`, or when the
  user is in `agent_whitelist`.
- `agent_whitelist(agent_id, user_id)`. RLS: users read their own rows.
- `usage_logs` and `subscription_usage_logs`, written only through the
  service-role upsert RPCs above (migrations
  `20260517100000_usage_logs_upsert_rpc.sql` and
  `20260517100100_usage_logs_aggregate_per_stream.sql`, per the relay record).
  The setup guide's original `usage_logs` DDL is older than the current
  columns.
- `device_auth_requests(device_code_hash, user_code, status, user_id,
poll_interval_seconds, last_polled_at, expires_at)`, service-role only.
- The storage bucket `agent-configs` is private. Its object policy is
  defense in depth; `get-agent-config` downloads with the service role after
  the RLS check.

The DDL and policy text as last published are in
`docs/supabase/SUPABASE_SETUP.md` (Parts 3-4, 8). The open-source readiness
audit (`../process/2026-08-01-open-source-readiness-audit.md`) records the
gaps between that text and the private migrations.

### 5.3 The hosted agent catalog

- Sources: `prompts/agents/remote/**/*.yaml` and
  `prompts/agents/remote/catalog.json` (storage folder and visibility).
- `scripts/sync-remote-agents.mjs` generates idempotent
  `INSERT … ON CONFLICT (name) DO UPDATE` SQL for `remote_agents` (132-171).
  With `--apply` it first checks that every `storage_path` exists in
  `storage.objects` (187-220). It runs through `supabase db query` (CLI
  ≥ 2.79.0). It never deletes rows.
- The YAML bodies are uploaded separately:
  `supabase storage cp prompts/agents/remote/<src>
ss:///agent-configs/<folder>/<name>.yaml` (`SUPABASE_SETUP.md`, Part 7).
- `.github/workflows/remote-agents-sync.yml` applies on push to `main` when
  those paths change. PRs only generate.
- User access is granted by SQL against `profiles.permissions` or
  `agent_whitelist` (`SUPABASE_SETUP.md`, Part 8).

### 5.4 Operations docs

- `docs/supabase/SUPABASE_SETUP.md` covers project creation, OAuth apps,
  redirect URLs, DDL/RLS, the storage bucket, function deploy, catalog sync
  and user management.
- `docs/supabase/AUTH_OPERATIONS.md` covers SMTP and mailer outages, Google
  OAuth "Testing" mode outages, the Before User Created hook, and sign-up
  funnel alert SQL (zero sign-ups in 24 h, split by provider).
- `docs/.vitepress/publicDocs.js` keeps both off texra.ai.

## 6. Subscription and billing hooks

The client has no payment, checkout or entitlement code. The only
billing-shaped server behavior:

- the split of `usage_logs` from `subscription_usage_logs`, with list-price
  equivalent cost for subscription rounds (section 4);
- the relay-era `profiles.tier` / `access_expires_at` columns, whose only
  reader, the relay's spend check, is gone (`attic/supabase-relay/`).

Provider subscriptions (ChatGPT, Grok, Kimi Code, GLM) sign in to the
provider directly (`src/auth/codex`, `src/auth/xai`, and API keys). They never
touch Supabase, and they are not part of this removal.

## 7. What must stay up until sunset

Released clients (≤ `v0.40.10`) call the hosted project directly, so these
must keep working until the announced sunset date:

1. **GoTrue auth** at `remote.texra.ai`: the GitHub and Google providers,
   their OAuth apps and client secrets, and the redirect allow-list in 3.2.
   Refresh token rotation must keep working for stored sessions.
2. **`auth-bridge`**, for desktop VS Code-family sign-in in released
   extensions.
3. **`auth-device`** and `device_auth_requests`, for released CLIs' `texra
login --device`.
4. **`before-user-created`** and its hook secret, for sign-up policy.
5. **`get-agent-config`**, `remote_agents`, `agent_whitelist`,
   `profiles.permissions` and the `agent-configs` bucket, because released
   clients load hosted agents. Keep `scripts/sync-remote-agents.mjs`,
   `prompts/agents/remote/` and the sync workflow so the catalog can still be
   corrected.
6. **`log-usage`** and its upsert RPCs, including the legacy relay-field
   tolerance (#10921) and the HTTP-200 rejection contract (#6981).
7. SMTP, if email sign-up stays enabled on the project.

`github-app-token-exchange` serves CI and has its own lifetime.

## 8. Keeping telemetry after sign-in leaves (the server change)

Without an account the client has no JWT, and `log-usage` accepts nothing
else. The smallest change that keeps usage flowing uses an anonymous install
id and no GoTrue user:

- **Client.** Mint a random UUID once per install (stored with the host's
  other state, not in secrets) and send it as `X-TeXRA-Install-Id` with no
  `Authorization` header. The payload stays the same.
- **Consent.** The existing gates are not enough on their own.
  `texra.telemetry.enabled` defaults to `true`, but today a signed-out install
  sends nothing. Minting an install id silently would start reporting for
  every install that never signed in. The change therefore needs a new consent
  decision for that cohort. Two options: an explicit opt-in, or a first-run
  notice that names what is sent and how to turn it off, shown before the
  first batch leaves. The owner picks the product answer. Either way, the
  environment opt-outs and the setting keep working as they do now.
- **`log-usage`.** When there is no bearer token, accept a well-formed
  install id and write rows with `user_id = NULL, install_id = <id>`. Keep the
  JWT path as it is for released clients.
- **Abuse.** A random UUID identifies an install but does not authenticate
  it. Anyone could post fabricated batches under chosen ids. Treat
  install-id rows as unauthenticated analytics, never as accounting. Add rate
  limits per install id and per IP at the function. If the data must resist
  forgery, issue a server-signed install credential instead: a small
  `register-install` function that returns an HMAC over the id, verified by
  `log-usage`. This is still less machinery than GoTrue anonymous users.
- **SQL**, applied in the private migrations repository:
  1. add a nullable `install_id uuid` to `usage_logs` and
     `subscription_usage_logs`;
  2. make `user_id` nullable if it is not already;
  3. add a check `user_id IS NOT NULL OR install_id IS NOT NULL`;
  4. teach both upsert RPCs to write `install_id`, and to aggregate on
     `(coalesce(user_id::text, install_id::text), stream_id)` instead of
     `(user_id, stream_id)`, because NULL user ids never conflict;
  5. make the dedup lookup key on `install_id` when `user_id` is NULL.

Enabling GoTrue anonymous sign-ins (`signInAnonymously`) was considered and
is not the recommendation. It is only a dashboard toggle, and
`before-user-created` already allows it. But it keeps the GoTrue client, a
stored refresh token and refresh logic on every host, which is the machinery
this removal deletes. It also adds an `auth.users` row per install, subject to
GoTrue's per-IP anonymous rate limit.

## 9. How to restore sign-in

1. Recover the client from the reference commit:
   `git show 98aa293907:<path>` for `src/auth/{config,constants,SupabaseAuth,SupabaseSession,supabaseSessionTypes,authCallback,authProgram,pendingOAuthState,TokenProvider}.ts`,
   `src/controllers/auth/{supabaseSignIn,pendingOAuthStore}.ts`, the host
   files named in 3.4, and the tests under `src/test-kernel/auth/`,
   `src/test-kernel/cli/{CliSupabaseAuth,SupabaseAuthDeviceCode,AuthCommand}.vitest.ts`
   and `src/test-kernel/commands/AuthCommandsStoredSession.vitest.ts`.
2. Re-add `@supabase/supabase-js` (catalog entry) to the root and
   `packages/agent` manifests.
3. Re-install the plane at each composition root:
   - the `auth` option of `installProcessRuntime`, with `SupabaseAuth` in
     `ProcessServices`;
   - the extension's `authentication` contribution and `registerSupabaseAuth`;
   - the desktop's pending store before the first window;
   - the CLI's `ensureCliSupabaseAuth`.
4. Re-add the `texra.auth.*` catalog entries and the command handlers, the
   Account tab's sign-in controls, and the CLI `login`/`logout`/`auth status`
   commands and `/login texra`.
5. If telemetry moved to install ids (section 8), decide whether a signed-in
   user sends the JWT or the install id. The server accepts both.
6. Server side, confirm everything in section 7 is still deployed, and that
   the redirect allow-list still holds every scheme in 3.2.
