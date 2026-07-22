# Proactive Token-Refresh Loop — Route-Gated Fix (Tournament Entry A)

**Status:** Proposal (2026-07-21). All claims verified first-hand against the working tree on
`feat/main-view-team-launcher`; no source files changed. Line numbers drift under checkout churn —
anchor edits on clause text.
**Scope:** The proactive pre-invocation client-refresh path in `RetryableInvocationNode` and the
credential/auth facts it needs: `src/agent/core/flows/RetryState.ts`,
`src/agent/core/flows/CycleServices.ts`, `src/agent/modelHandlers/ModelHandler.ts`,
`src/agent/types/IModelHandler.ts`, `src/auth/SupabaseClient.ts`.
**Related:** [`lifecycle-status-ownership.md`](./lifecycle-status-ownership.md) (finding **L2** —
"relay auth recovery inside the generic retry base class", p. 2026-06-10), commit `f2adcb8c17`
(#9030, "snapshot model credential routes" — the `ModelCredentialRoute` infrastructure this fix
builds on).

## TL;DR — verdict

**Gate the proactive refresh on the credential the call will actually present.** The proactive
branch fires whenever the stored _session_ nears expiry, but the next model call only presents
that session token when the live client's route is `'relay'` _and_ no live CI relay token
overrides it. Add one live query — the client's recorded `ModelCredentialRoute`, already
snapshotted by #9030 — bridged through `withModelClient` next to `refreshClient`, plus one
CI-aware predicate on `SupabaseClient`. ~40 lines of source across five files; relay protection
is preserved exactly, personal-key users stop rebuilding clients every few seconds for up to 30
minutes, and no network call is added to the hot path.

## Problem statement

**Symptom (user log, personal-key mode).** Before nearly every model invocation:

```
Token nearing expiry, refreshing client proactively
Refreshed model client proactive pre-invocation
```

repeating every few seconds for up to ~30 minutes, each occurrence rebuilding the provider client.

**Impact.** Log spam that drowns real trace lines; a full client rebuild (credential resolution,
secret reads, SDK construction) before every invocation of every node for the entire last 30
minutes of a session; on Google handlers the rebuild also drops the cached client
(`modelHandlerGoogleGenAI.ts:189-193`, `modelHandlerGoogleInteractions.ts:555-559`). The check
guards a credential the call never presents — in personal-key mode the route is `'api-key'` or
`'openrouter'` and the relay token is not used at all.

## Root-cause evidence (all verified)

**E1 — the proactive branch rebuilds but never re-auths.**
`RetryState.ts:188-198` (`RetryableInvocationNode.withAbortController`):

```typescript
// Proactive relay token refresh before the request
if (SupabaseClient.isTokenExpiringSoon()) {
  services.logger.debug('Token nearing expiry, refreshing client proactively');
  await tryRefreshClient(
    services.refreshClient,
    services.logger,
    'proactive pre-invocation',
  );
}
```

`services.refreshClient` is bridged by `withModelClient` (`CycleServices.ts:62-70`) to
`ModelHandler.refreshClient()` (`ModelHandler.ts:1026-1030`), which is only
`return this.getClient(selection)`. Nothing on this path calls `getRelayAccessToken(true)` and
nothing updates `SupabaseClient.tokenExpiresAt`. Only the _reactive_ relay-401 path does
(`RetryState.ts:136`).

**E2 — the predicate is session-only and sticky.**
`SupabaseClient.isTokenExpiringSoon()` (`SupabaseClient.ts:92-97`) reads the in-memory
`tokenExpiresAt` and returns true within `TOKEN_REFRESH_THRESHOLD_MS = 30 * 60 * 1000`
(`src/auth/config.ts:261`). `tokenExpiresAt` is written only by
`SupabaseClient.setTokenExpiry`, called from the session coordinator's `onTokenExpiryChanged`
hook (`SupabaseAuthCoordinator.ts:59-60`, fired by `storeSession`/`clearSession` in
`SupabaseSession.ts:85,90`) and from the VS Code auth provider's session load
(`packages/extension/src/frontend/auth/SupabaseAuthProvider.ts:203`). Once the session enters
its last 30 minutes, the predicate stays true on _every_ invocation until something stores a
fresh session.

**E3 — why relay users never see the loop: the rebuild self-terminates for route `'relay'`
only.** A relay-route rebuild goes `getClient` → `resolveClientCredential` →
`SupabaseClient.getRelayAccessToken()` (`ModelHandler.ts:505`) → `getAccessToken()` →
`SupabaseSessionCoordinator.getFreshSession()`, which _itself_ refreshes proactively within the
same 30-minute threshold (`SupabaseSession.ts:249-259`) and stores the refreshed session —
updating `tokenExpiresAt` as a side effect. Personal-key routes
(`ModelHandler.ts:539-567`, routes `'api-key'`/`'openrouter'`) never touch the relay token, so
nothing clears the predicate and the loop runs until the session expires for real. The
30-minute window matches the symptom exactly.

**E4 — the route is already recorded; the retry layer just can't see it.** #9030 added
`ModelCredentialRoute = 'api-key' | 'chatgpt-subscription' | 'openrouter' | 'relay'`
(`ModelHandlerContracts.ts:35-36`) and a per-client snapshot `clientCredentialRoutes: WeakMap`
(`ModelHandler.ts:201-205`), written by `rememberClientCredentialRoute` (`ModelHandler.ts:571-577`)
at every SDK-client construction site (verified: OpenAI `:256`, OpenAI Responses `:1158`, Codex
`:320`, Anthropic `:264`, Google GenAI `:185`, Google Interactions `:551`, OpenRouter `:169`) and
read by `createResponse` (`ModelHandler.ts:1059-1062`). Two handlers legitimately record nothing:
`modelHandlerVscodeLm.getClient` (`:206`, VS Code LM auth, not relay) and the validation stub
(`modelHandlerValidation.ts:64`). The route snapshot is the authoritative answer to "will the
next call present the session relay token" — re-deriving intent from config
(`usesServerSideKeysRoute`) would drift from the captured fact, the exact hazard #9030 was
merged to remove.

**E5 — the CI relay token makes even route `'relay'` loop.** With `TEXRA_RELAY_TOKEN` set
(`relayToken.ts:41-47`), `getRelayAccessToken()` returns the static token without touching the
session (`SupabaseClient.ts:229-244`, cache-only by design — the comment at `:240-243` forbids a
probe on this path). A signed-in CI user on the relay route whose session nears expiry loops
exactly like a personal-key user: the presented credential (static token) cannot expire, yet the
predicate guards the session. The defect statement's root cause missed this case; the fix must
not (and must not call `getRelayAccessToken(true)` here either — with a CI token configured,
`forceRefresh` records the token as _rejected_, `SupabaseClient.ts:231-237`).

**E6 — liveness constraints.** `withModelClient`'s getter + `refreshClient` are defined on the
returned literal, never spread, so rebinding survives (`CycleServices.ts:44-51`). Both cycle
nodes bridge through it (`ToolUseCycleNode.ts:103`, `ResponseCycleNode.ts:107`).
`ModelInvocationNode` is the only production subclass of `RetryableInvocationNode` (verified by
grep), and its services already carry `modelHandler` and the live `client`
(`ModelInvocationNode.ts:60-67`). The proactive path has **zero test coverage** today (no
test-kernel file references `isTokenExpiringSoon`/`setTokenExpiry` outside
`CodexSessionCoordinator`'s own buffer test).

## Chosen design — route-gated proactive refresh (Direction A, CI-hardened)

**One rule:** run the proactive refresh only when the next invocation will present the
session-backed relay token _and_ that session is near expiry. Two facts, each owned by the layer
that already knows it:

- _What credential will the live client present?_ → the handler's route snapshot (ModelHandler).
- _Is the session-backed relay token expiring?_ → SupabaseClient, CI-token-aware (mirrors the
  existing cache-only pattern in `isAuthenticated`, `SupabaseClient.ts:357-368`).

The retry layer keeps the _policy_ (when a proactive refresh is worthwhile); it already owns the
reactive relay-401 policy and imports `SupabaseClient` for it (`RetryState.ts:136`).

### File 1 — `src/agent/modelHandlers/ModelHandler.ts` (add one public query)

Next to `rememberClientCredentialRoute` (`:571-577`):

```typescript
/**
 * Credential route captured by a client this handler built, or undefined for
 * foreign clients and the route-less ones (vscode-lm, validation stub). Reads
 * the same snapshot {@link createResponse} uses, so pre-invocation policy sees
 * the route the next call will actually present.
 */
getClientCredentialRoute(client: C): ModelCredentialRoute | undefined {
  if (typeof client !== 'object' || client === null) {
    return undefined;
  }
  return this.clientCredentialRoutes.get(client);
}
```

### File 2 — `src/agent/types/IModelHandler.ts` (one line)

Add `'getClientCredentialRoute'` to the `Pick` union (after `'refreshClient'`). The port is a
`Pick` of the class precisely so this cannot drift (`IModelHandler.ts:14-21`).

### File 3 — `src/agent/core/flows/CycleServices.ts` (bridge, same liveness discipline)

```typescript
export interface ModelClientServices<C = unknown> {
  readonly client: C;
  readonly refreshClient?: (
    selection?: ModelCredentialSelection,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Live lookup of the credential route captured by {@link client}. */
  readonly clientCredentialRoute?: () => ModelCredentialRoute | undefined;
}
```

In `withModelClient`, on the returned literal (closure over the same `client` binding as the
getter — it follows every `refreshClient` rebinding automatically):

```typescript
clientCredentialRoute: () => modelHandler.getClientCredentialRoute(client),
```

Extend the `:44-51` doc comment to state the route lookup shares the live binding and must not
be snapshotted either.

### File 4 — `src/auth/SupabaseClient.ts` (CI-aware predicate)

After `isTokenExpiringSoon` (`:92-97`); both helpers are already imported here (`:13-18`):

```typescript
/**
 * Whether the credential a relay-bound call would present right now is a
 * session token nearing expiry. A configured CI relay token is static and
 * session-independent, so session expiry is irrelevant while one is live; a
 * known-rejected one is skipped and the session is presented instead.
 * Cache-only like {@link getRelayAccessToken} — no probe on the model-call path.
 */
static isSessionRelayTokenExpiringSoon(): boolean {
  const relayToken = getConfiguredRelayToken();
  if (relayToken && getCachedRelayTokenState(relayToken) !== 'invalid') {
    return false;
  }
  return this.isTokenExpiringSoon();
}
```

### File 5 — `src/agent/core/flows/RetryState.ts` (the gate)

`RetryableNodeServices` gains the optional field (alongside `refreshClient`, `:63-66`):

```typescript
/** Route of the credential captured by the live client (bridged by withModelClient). */
clientCredentialRoute?: () => ModelCredentialRoute | undefined;
```

The proactive branch (`:188-198`) becomes:

```typescript
// Proactive relay token refresh before the request — only when the live
// client will actually present the session-backed relay credential. Other
// routes (personal API key, OpenRouter, ChatGPT subscription, CI relay token)
// never send that token; rebuilding their clients here only churns. Unknown
// route (unbridged services, vscode-lm, validation stub) fails safe to skip:
// the reactive 401 recovery below remains the guarantee.
if (
  services.clientCredentialRoute?.() === 'relay' &&
  SupabaseClient.isSessionRelayTokenExpiringSoon()
) {
  services.logger.debug('Token nearing expiry, refreshing client proactively');
  await tryRefreshClient(
    services.refreshClient,
    services.logger,
    'proactive pre-invocation',
  );
}
```

`ModelInvocationNode` needs no change: its `TServices` is satisfied structurally by the enriched
bag, and the base class reads the field through `Svc extends RetryableNodeServices`.

### Why this fixes symptom _and_ root cause

- Personal-key / OpenRouter / Codex-subscription / vscode-lm users: route ≠ `'relay'` → the
  branch never runs. Loop eliminated, however long the run.
- Session-relay users: unchanged behavior — one proactive rebuild refreshes the session
  side-effectively (E3) and the predicate clears. Protection preserved.
- CI-token users (signed-in or not): static token never expires → branch never runs; no
  `forceRefresh`, so no spurious rejection marking. Constraint honored.
- No new network calls: WeakMap lookup + two in-memory/cache reads.

## Edge cases

| Case                                                                          | Behavior under the fix                                                                             | Why it's right                                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| CI relay token configured, session expiring, relay route                      | Skip (E5)                                                                                          | Presented credential is static; session expiry irrelevant to the call                                                                  |
| CI token known-rejected, session expiring, relay route                        | Fire                                                                                               | `getRelayAccessToken` falls through to the session (`SupabaseClient.ts:238-246`); the session _is_ the presented credential            |
| Mid-run model switch via manual retry (`refreshClient(selection)`)            | Route query follows the rebinding (closure over `client`)                                          | Relay→personal stops proactive refreshes; personal→relay enables them. `withModelClient` liveness (`CycleServices.ts:44-51`) untouched |
| User not signed in                                                            | `tokenExpiresAt === null` → predicate false                                                        | Unchanged from today (`SupabaseClient.ts:93-95`)                                                                                       |
| Offline                                                                       | Gate reads only memory/caches; if the later relay call 401s, reactive recovery handles it as today | No probe added; refresh failure path unchanged                                                                                         |
| vscode-lm / validation stub clients (no recorded route)                       | `undefined` → skip                                                                                 | These calls present no relay credential                                                                                                |
| `chatgpt-subscription` (Codex) route                                          | Skip                                                                                               | Codex has its own 5-minute-buffer refresh (`CodexSessionCoordinator`, tested at `CodexSessionCoordinator.vitest.ts:154`)               |
| >30 min with no invocations (long tool run, waiting on user)                  | Proactive never fires; first call after expiry 401s → reactive recovery                            | Identical to today — the reactive path is the real guarantee even now                                                                  |
| Handler that forgets `rememberClientCredentialRoute` on a future relay client | Degrades to reactive-only protection for that handler                                              | Strict `=== 'relay'` gate fails safe: no needless rebuilds, 401 recovery intact                                                        |

## Alternatives evaluated

Criteria: **(1) correctness** (relay protected, personal-key never rebuilds needlessly, no
hot-path probes), **(2) separation of concerns**, **(3) minimalism**, **(4) convention fit &
testability**.

### B — make the proactive path actually refresh the token

Call `getRelayAccessToken(true)` in the proactive branch; rebuild only when the token changed.

- **(1) Fails the CI constraint directly.** With `TEXRA_RELAY_TOKEN` configured, `forceRefresh`
  marks the static token _rejected_ (`SupabaseClient.ts:231-237`) — a valid CI credential would
  be poisoned by an unrelated session-expiry check. Gating the force-refresh on
  `getConfiguredRelayToken()` re-adds the CI-awareness the champion already needs, so B is not
  simpler in the end.
- **(1) Adds a hot-path network call for the wrong users.** A signed-in personal-key user would
  pay a Supabase session refresh (rotating the refresh token) before model calls that never
  present the session — a side-effecting network op the "no new probes" constraint exists to
  prevent. (B-without-`force` doesn't even self-terminate in the CI+session case: the static
  token returns early and `tokenExpiresAt` stays stale.)
- Verdict: **rejected** — fixes the loop by doing unneeded auth work, and breaks the CI path.

### C — push credential freshness down into the credential layer

Add e.g. `ensureFreshClient()` to the handler/port; RetryState stops importing SupabaseClient.

- **(2) Best long-term separation** — and already the documented one: finding **L2** of
  `lifecycle-status-ownership.md` rules this seam wrong-layer and prescribes "the 401-refresh
  policy moves behind that injected boundary; `RetryState` keeps only 'ask the client to
  refresh, retry once'".
- **(3) But the full move is a refactor, not a fix.** The reactive path entangles
  `_hasAttemptedTokenRefresh`, `_persistent401Error`, a fresh `AbortController`, and
  retry-once semantics (`RetryState.ts:128-173`); re-homing the token call means redesigning
  that orchestration and its (currently nonexistent) tests. And C alone doesn't fix the defect
  unless it _also_ gains route awareness — the champion's gate is required either way.
- Verdict: **rejected as the fix vehicle; kept as direction.** The champion is the minimal step
  along L2's line: the route query moves behind the injected services boundary, the policy stays
  with retry. Moving the reactive token call behind the same bridge later is a small follow-up.

### D — delete the proactive path; rely on reactive 401 recovery

- **(3) Most minimal** (~10 lines deleted) and deletes the defect class outright. The reactive
  path is genuinely sufficient: expiry mid-request cannot 401 (auth is checked at request
  start), and the no-invocations-during-the-window case already relies on reactive recovery
  today.
- **(1) But it downgrades relay UX on every expiry crossing.** Each crossing becomes a wasted
  request (full prompt payload) plus a forced refresh plus recovery churn on long relay runs —
  exactly what the proactive path exists to avoid (constraint: preserve or argue away). The gate
  fix costs ~5 lines and keeps a mechanism that works correctly for relay users (E3), so the
  deletion buys little. It also orphans `isTokenExpiringSoon` (single consumer) rather than
  repairing the seam.
- Verdict: **rejected** — the runner-up; revisit only if the proactive path shows further
  defects after gating.

### E — latch/debounce (at most one proactive refresh per N minutes per run)

- **(1) Treats the symptom, not the cause.** Personal-key users still get periodic pointless
  rebuilds; the check still guards a credential the call doesn't use.
- **(4) Latch placement fights the architecture.** Node instances are cloned per run and
  `clone()` resets fields (`RetryState.ts:115-122`); a module-level latch is a bare mutable
  singleton, which the repo's testing rules prohibit (AGENTS.md, code-quality rules).
- Verdict: **rejected** — a band-aid with the worst convention fit of the five.

### Score summary

| Option           | (1) Correctness                              | (2) Separation                                    | (3) Minimalism                    | (4) Fit/testability                                           |
| ---------------- | -------------------------------------------- | ------------------------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| **A (champion)** | Relay + CI + personal all correct; no probes | Fact ownership per layer; policy stays with retry | ~40 src lines, 5 files            | Builds on #9030; mirrors `isAuthenticated`; easy to unit-test |
| B                | Breaks CI path; wrong-users network call     | Same shape as A                                   | Similar size, more special-casing | Needs CI special-case tests anyway                            |
| C                | Same as A once route-aware                   | Best (L2's north star)                            | Large: reactive-path re-home      | Heavy test redesign                                           |
| D                | Relay degradation per expiry                 | Removes the seam instead of fixing it             | Smallest diff                     | Deletes coverage-needing code                                 |
| E                | Loop persists (slower)                       | None                                              | Small but stateful                | Violates singleton/testing rules                              |

## Test plan (Vitest, `src/test-kernel/`)

**`src/test-kernel/agent/runtime/RetryState.vitest.ts`** — extend `TestRetryServices` with
`clientCredentialRoute` and expose `withAbortController` on `ExposedRetryNode` (public wrapper
driving a trivial operation). Add `afterEach(() => SupabaseClient.resetForTests())`. New cases:

1. _Personal-key route:_ route `() => 'api-key'`, `SupabaseClient.setTokenExpiry(Date.now() + 60_000)`
   → run → `refreshClient` **not called**, operation still ran.
2. _Relay route, expiring session:_ route `() => 'relay'`, same expiry → `refreshClient` called
   **once**.
3. _Relay route, fresh session:_ `setTokenExpiry(Date.now() + 2 * 3_600_000)` → not called.
4. _Unbridged services (unknown route):_ no `clientCredentialRoute` field, expiring session →
   not called (pins the fail-safe default covering vscode-lm/validation clients).
5. _Live CI token:_ `withRelayTokenEnv(...)` (pattern from `SupabaseClient.vitest.ts:25-40`) +
   route `'relay'` + expiring session → not called; reset env + `resetRelayTokenTierCacheForTests()`.
6. _Regression anchor:_ assert no "Token nearing expiry" debug log fires in case 1 (the reported
   symptom).

**`src/test-kernel/auth/SupabaseClient.vitest.ts`** — `isSessionRelayTokenExpiringSoon`:

7. No expiry tracked → false. 8. Fresh session → false. 9. Expiring session → true.
8. Live CI token + expiring session → false. 11. Known-rejected CI token (seed via
   `fetchRelayTokenStatus` invalid, per `:110-138`) + expiring session → true.

**`src/test-kernel/agent/modelHandlers/ModelClientRouteSnapshot.vitest.ts`** (existing
`withModelClient` harness):

12. `clientCredentialRoute()` reflects the initial client's route and follows a `refreshClient`
    rebinding to the replacement client's route (live-binding twin of the `:23-39` test).

**Handler-level (extend `ModelHandlerApiKey.vitest.ts` or `GoogleClientRouteCache.vitest.ts`):**

13. `getClientCredentialRoute` returns the recorded route for a handler-built client and
    `undefined` for a foreign object — pinning the WeakMap contract against future construction
    sites that forget `rememberClientCredentialRoute`.

**Verify:** `npm run typecheck`, `npm run lint`, `npm test` (AGENTS.md workflow).

## Risks

- **R1 — silent degradation if a future relay-capable client forgets the route snapshot.** The
  strict `=== 'relay'` gate then degrades that handler to reactive-only protection. Backstop
  (reactive 401 recovery) is intact; mitigated by test 13 and by #9030 having made
  `rememberClientCredentialRoute` the established construction-site pattern.
- **R2 — test-isolation hazard, not product risk:** `SupabaseClient` is a singleton; the new
  RetryState cases must reset it (`resetForTests`) and the relay-token cache, matching the auth
  suite's `afterEach` (`SupabaseClient.vitest.ts:54-57`) per the repo's no-shared-mutable-state
  testing rule.
- **R3 — behavior change is strictly subtractive.** No path that fires today and is load-bearing
  is removed: session-relay still fires; everything silenced was a rebuild whose only effect was
  churn. The reactive 401 path is untouched.
- **R4 — port growth.** `IModelHandler` gains one member; because the port is a `Pick` of
  `ModelHandler`, the addition is one line and cannot drift from the class.

## Rejected alternatives, one line each

- **B:** poisons live CI tokens via `forceRefresh` and does unneeded session auth on the hot path.
- **C (full):** the documented north star (L2) but a refactor of reactive-401 orchestration; the
  champion is its minimal first step.
- **D:** converts every relay expiry crossing into a guaranteed failed request to save ~5 lines.
- **E:** debounces the symptom, keeps the cause, and needs a forbidden module-level latch.
