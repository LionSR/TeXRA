# Proactive Token Refresh — Route-Gated, Self-Terminating Redesign

**Status:** Design proposal (tournament entry, 2026-07-21). Analysis only — no source files changed. All claims re-verified against current source; `file:line` citations throughout.
**Scope:** The proactive pre-invocation token check in the agent retry layer (`src/agent/core/flows/RetryState.ts`), its supporting credential plumbing (`CycleServices.ts`, `ModelHandler.ts`, `IModelHandler.ts`), and the auth expiry clock (`src/auth/SupabaseClient.ts`, `src/auth/SupabaseSession.ts`).
**Recommended design:** **A′ — route-gated, self-terminating proactive refresh**: only relay-route clients consult the expiry clock, the branch triggers the real threshold-gated session refresh, and the client is rebuilt only when the token actually rotated. ~25 net lines across 5 files, no new abstractions.

## TL;DR

The proactive check is **route-blind**. Its loop termination depends on the client rebuild re-resolving the relay credential — which refreshes the Supabase session _as a side effect_ inside `getClient()` — a mechanism that exists **only on the relay route**. In personal-key mode the rebuild never touches the session token, the entry condition can never clear, and every model invocation rebuilds the provider client for up to 30 minutes (half the 1-hour default session lifetime). The fix is not to debounce the loop but to close the gate: check the credential route of the client that will actually make the call, refresh the token explicitly, and rebuild only on rotation. Relay protection is preserved — in fact it becomes honest for the first time: the branch now does what its own log messages claim.

## Problem statement

**Symptom (user log, personal-key mode):** before nearly every model invocation,

```
Token nearing expiry, refreshing client proactively
Refreshed model client proactive pre-invocation
```

repeats every few seconds for up to ~30 minutes, each occurrence rebuilding the provider SDK client.

**Impact:** wasted client construction on every invocation of every node of every subagent for half the session lifetime; log spam that masks real events; and — discovered during this analysis — the relay protection the branch exists for is implemented only implicitly, as a side effect nobody documented.

## Root-cause evidence (verified)

1. **The proactive branch.** `RetryableInvocationNode.withAbortController` (`src/agent/core/flows/RetryState.ts:188-198`) runs before every model operation:

   ```ts
   // Proactive relay token refresh before the request
   if (SupabaseClient.isTokenExpiringSoon()) {
     services.logger.debug(
       'Token nearing expiry, refreshing client proactively',
     );
     await tryRefreshClient(
       services.refreshClient,
       services.logger,
       'proactive pre-invocation',
     );
   }
   ```

   (The defect brief said `executeWithRetry`; the method is actually named `withAbortController` — same location.) `ModelInvocationNode.exec` is the **only** production caller (`src/agent/core/flows/ModelInvocationNode.ts:133`), and `ModelInvocationNode` is the only production subclass of `RetryableInvocationNode` (grep-verified), so the check fires once per model invocation per node.

2. **The expiry clock.** `SupabaseClient.isTokenExpiringSoon()` (`src/auth/SupabaseClient.ts:92-97`) returns true when the cached `tokenExpiresAt` is within `TOKEN_REFRESH_THRESHOLD_MS = 30 * 60 * 1000` (`src/auth/config.ts:261`), and false when no expiry is tracked. The default session lifetime is 1 hour (`src/auth/supabaseSessionTypes.ts:5`, `DEFAULT_SUPABASE_SESSION_EXPIRY_MS`), so a session spends up to half its life "expiring soon" — matching the ~30-minute symptom window.

3. **The branch never refreshes the token.** `services.refreshClient` is bridged by `withModelClient` (`src/agent/core/flows/CycleServices.ts:52-72`) to `ModelHandler.refreshClient()` (`src/agent/modelHandlers/ModelHandler.ts:1026-1030`), which is just `return this.getClient(selection)`. Every concrete `getClient` builds a **brand-new** SDK client (e.g. `modelHandlerAnthropic.ts:257-270`, `modelHandlerOpenAI.ts:260-265`) — no caching. Nothing in the proactive branch calls `getRelayAccessToken`; only the **reactive** relay-401 recovery does, with `forceRefresh` (`RetryState.ts:136`, inside `attemptRelay401Recovery`, lines 128-173).

4. **Why relay users' loop self-terminates today (the mechanism the bug report hinges on).** On the relay route, `getClient()` → `resolveClientCredential()` takes the `useRelay` branch (`ModelHandler.ts:498-530`) and calls `SupabaseClient.getRelayAccessToken()` (line 505, non-forced). That reaches `SupabaseSessionCoordinator.getFreshSession` (`src/auth/SupabaseSession.ts:240-259`), which — when within the same 30-minute threshold — calls `refreshSession` → `storeRefreshIfCurrent` → `storeSession` → `onTokenExpiryChanged` → `SupabaseClient.setTokenExpiry(newExpiresAt)` (`SupabaseSession.ts:80-86, 249-259, 313-324`; wired at `src/auth/SupabaseAuthCoordinator.ts:59-60`; also seeded at `packages/extension/src/frontend/auth/SupabaseAuthProvider.ts:203`). So for relay clients the first proactive rebuild refreshes the session and clears the condition. Concurrent attempts are deduped by `refreshPromise` (`SupabaseSession.ts:198-226`).

5. **Why personal-key users loop forever.** In personal-key mode the resolved route is `'api-key'` or `'openrouter'` (`ModelHandler.ts:535-566`; route type at `src/agent/types/ModelHandlerContracts.ts:35-36`, tracked per client via the `clientCredentialRoutes` WeakMap at `ModelHandler.ts:201-204, 571-577`). The api-key branch never calls `getRelayAccessToken`, so nothing updates `tokenExpiresAt`, `isTokenExpiringSoon()` stays true, and **every** invocation rebuilds the client — guarding a credential the call does not present. The loop ends only when the session expires and something else (VS Code auth `getSessions`, or the reactive 401 path for a relay call) refreshes it.

**Root cause, one sentence:** the guard's termination mechanism (credential re-resolution during rebuild) exists only on the relay route, but the guard itself is route-blind — so on non-relay routes it fires unconditionally and can never clear itself.

## Chosen design: A′ — route-gated, self-terminating proactive refresh

Four small edits, one concept: **the retry layer asks "which credential will this call present?" before consulting the relay expiry clock, and rebuilds only when the answer's token actually rotated.**

### 1. `src/agent/modelHandlers/ModelHandler.ts` — expose a client's captured route

The base class already records every constructed client's route (`rememberClientCredentialRoute`, lines 571-577; all relay-capable handlers call it — grep-verified across `anthropic`, `openai`, `openai/modelHandlerOpenAIResponse`, `openai/modelHandlerCodex`, `google/*`, `openrouter/*`). Add a public reader next to it:

```ts
/** Route of the credential a client built by this handler captured, if known. */
getCredentialRouteForClient(client: C): ModelCredentialRoute | undefined {
  return typeof client === 'object' && client !== null
    ? this.clientCredentialRoutes.get(client)
    : undefined;
}
```

(The object guard mirrors the existing lookup in `createResponse`, `ModelHandler.ts:1059-1061`.)

### 2. `src/agent/types/IModelHandler.ts` — add to the port `Pick`

Add `'getCredentialRouteForClient'` next to `'getLastCredentialUsageRoute'` (line 66). The port is a `Pick` of the base class precisely so this kind of addition is one line and cannot drift.

### 3. `src/agent/core/flows/CycleServices.ts` — publish the live route beside `client`

`withModelClient` already documents why `client` and `refreshClient` are defined on the returned literal, never spread (lines 44-51). Add the route as a sibling getter on the same literal so it rebinds together with `client` (e.g. after a mid-run model switch):

```ts
// In ModelClientServices<C> (line 32):
readonly clientCredentialRoute?: ModelCredentialRoute | undefined;

// In the returned literal of withModelClient (after the `client` getter, line 59):
get clientCredentialRoute(): ModelCredentialRoute | undefined {
  return modelHandler.getCredentialRouteForClient(client);
},
```

`ModelCredentialRoute` is imported from `@agent/types/ModelHandlerContracts`, which the file already imports (line 12-16). Both production call sites spread `this.services` as the _base_ and apply `withModelClient` afterwards (`tooluse/nodes/ToolUseCycleNode.ts:103-110`, `reflection/nodes/ResponseCycleNode.ts:107-115`), so the getter reaches the flow unsnapshotted under the existing discipline.

### 4. `src/agent/core/flows/RetryState.ts` — gate, refresh, rebuild-on-rotation

Add `clientCredentialRoute?: ModelCredentialRoute` to `RetryableNodeServices` (line 59-67; type import already present at line 10) and to the `InvocationServices` literal in `ModelInvocationNode.ts:60-67` for documentation honesty. Rewrite the proactive block (lines 188-198):

```ts
// Proactive relay token refresh before the request. Only relay-route
// clients present the Supabase session token, so only they consult the
// expiry clock — personal-key / openrouter / subscription clients must
// never rebuild for a credential the call doesn't use.
if (
  services.clientCredentialRoute === 'relay' &&
  SupabaseClient.isTokenExpiringSoon()
) {
  // Threshold-gated and mutex-deduped: refreshes the session (updating
  // tokenExpiresAt) only when actually near expiry. For a configured CI
  // relay token this is a cache-only read with no side effects.
  await SupabaseClient.getRelayAccessToken();
  // Rebuild only when the token actually rotated — rebuilding with the
  // same JWT changes nothing, and is exactly the loop this branch caused.
  if (!SupabaseClient.isTokenExpiringSoon()) {
    await tryRefreshClient(
      services.refreshClient,
      services.logger,
      'proactive pre-invocation',
    );
  }
}
```

The reactive 401 path (`attemptRelay401Recovery`) is untouched.

### Why the loop cannot restart, per mode

| Mode                                             | Behaviour                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal key / OpenRouter / ChatGPT-subscription | First conjunct false → branch never entered. Zero auth calls, zero rebuilds, zero log lines.                                                                                                                                                                                                                  |
| Relay, refresh succeeds                          | `getRelayAccessToken()` refreshes the session and updates `tokenExpiresAt`; second conjunct false for another ~30+ min; exactly **one** rebuild, capturing the fresh JWT.                                                                                                                                     |
| Relay, refresh fails (offline / revoked)         | Expiry unchanged → **skip the pointless rebuild**; the next call proceeds with the stale client and, once the token dies, the existing reactive 401 recovery (`RetryState.ts:128-173`) takes over. No rebuild spam.                                                                                           |
| CI relay token (`TEXRA_RELAY_TOKEN`)             | Non-forced `getRelayAccessToken()` returns the configured token after a cache-only status read (`SupabaseClient.ts:229-245`); it never marks the token rejected (that is `forceRefresh`-only, lines 231-237) and never touches the session. The branch degenerates to a cheap no-op — no rebuilds, no probes. |
| Not signed in                                    | `tokenExpiresAt` is null → `isTokenExpiringSoon()` false (`SupabaseClient.ts:93-95`) → no-op.                                                                                                                                                                                                                 |
| Mid-run model switch                             | `refreshClient` rebinds `client`; the route getter reads the **new** client's route on next access. Switch relay→personal closes the gate immediately; personal→relay opens it correctly.                                                                                                                     |

### Constraint check

- **Relay protection preserved — and made real.** The branch now performs the threshold-gated session refresh itself, instead of relying on an undocumented side effect of `getClient()`.
- **No new network probes on the hot path.** The only added call sits behind two synchronous in-memory gates (route, expiry clock) and its network activity is the threshold-gated, `refreshPromise`-deduped session refresh — the same operation the reactive path and today's relay-route `getClient()` already perform. For non-relay routes nothing is called at all. The cache-only contract of `getRelayAccessToken` (`SupabaseClient.ts:238-244`) is untouched.
- **Live-rebinding semantics preserved.** The route getter is defined on the `withModelClient` returned literal, same closure and discipline as `client`.
- **CI relay token path intact.** Non-forced reads only; `markRelayTokenRejected` stays reachable exclusively from the relay-401 recovery.

## Alternatives evaluated

### B — make the proactive path refresh, without the route gate

Call `getRelayAccessToken()` unconditionally when `isTokenExpiringSoon()`, rebuild on rotation. For signed-in personal-key users the loop _does_ terminate (the session refresh updates `tokenExpiresAt`), so it beats the status quo — but it fixes the loop by **doing relay auth on behalf of calls that don't use it**: a hot-path auth network call for exactly the users who reported the bug, plus one pointless client rebuild per window (the rebuilt client captures the same personal API key). Offline, it degrades to a _failed network attempt per invocation_ — arguably worse spam than today's rebuilds. It treats all routes as relay because it can't tell them apart. **Loses on correctness (criterion 1) and separation (2).**

### C — push freshness into the credential layer (`ensureFreshClient` on the handler port)

`RetryState` calls `services.ensureFreshClient()`; `withModelClient` delegates to a new `ModelHandler.ensureFreshClient(client)` that owns the route check, the token refresh, and the rebuild decision. This is the deepest module boundary and the shape I'd choose in a greenfield design. It loses here on **minimalism (3)** and marginally on separation: it introduces a second client-lifecycle verb alongside `refreshClient` (callers must now know which to use when), widens the `IModelHandler` port for every handler conceptually, and its practical win is small because `RetryState` still legitimately imports `SupabaseClient` for the relay-401 recovery — relay-specific retry policy lives in the retry layer either way. If credential policy grows (e.g. proactive ChatGPT-subscription refresh), C is the right evolution of A′'s accessor; A′ is the minimal step that doesn't pre-build for it. **Loses on (3), ties on (1).**

### D — delete the proactive path, rely on reactive 401 recovery

Smallest possible diff (−11 lines) and an honest argument exists: a relay 401 is a pre-dispatch rejection with no side effects, and recovery already refreshes + retries once. But the proactive path is _not_ dead code for relay users — per evidence item 4, it currently prevents the mid-run 401 in the common case (one side-effecting rebuild per window). Deleting converts "zero failed calls per expiry" into "one failed provider call + recovery per expiry" for every relay run spanning a session boundary, makes an error blip visible in interactive sessions, and leaves `isTokenExpiringSoon` dead. The constraints require relay protection to be preserved or deliberately argued away; A′ keeps it at lower cost than today, so the trade-off buys nothing. **Loses on correctness (1).**

### E — latch/debounce (at most one proactive refresh per N minutes per run)

Pure symptom treatment: the route-blind guard and the never-refreshing rebuild both survive; personal-key users still pay pointless rebuilds, just fewer; needs new per-run state with an arbitrary constant; and a latch naive to routes can _delay_ the one relay rebuild that matters. **Loses on (1), (2), and (3).**

### Scorecard

| Criterion                                                                         | A′ (chosen)                                                                     | B                                                    | C                           | D                                   | E                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------- | ----------------------------------- | --------------------------------------- |
| 1. Correctness (relay protected; personal-key never rebuilds; no hot-path probes) | ✅ all three                                                                    | ⚠️ personal-key pays auth calls; offline retry storm | ✅                          | ⚠️ relay loses proactive protection | ❌ root cause intact                    |
| 2. Separation of concerns                                                         | ✅ route knowledge stays in `ModelHandler`; retry layer keeps only retry policy | ❌ retry layer does relay auth for non-relay calls   | ✅✅ (best)                 | ✅                                  | ❌ policy + timing state in retry layer |
| 3. Minimalism                                                                     | ✅ ~25 net lines, no new verbs                                                  | ✅ similar size                                      | ⚠️ new port verb + bridging | ✅✅ smallest                       | ⚠️ new state                            |
| 4. Convention fit & testability                                                   | ✅ `Pick`-port + literal-getter patterns; plain vitest seams                    | ✅                                                   | ✅                          | ✅ (but deletes coverage)           | ⚠️ timer state to fake                  |

## Edge cases

- **CI relay token + stale signed-in session (dev machine):** route is `'relay'`, session expiry is stale. Non-forced `getRelayAccessToken()` returns the CI token without touching the session, expiry stays stale, rebuild is skipped. The branch fires per invocation but does **nothing observable** (two sync checks + one sync cache read; no logs, no rebuilds, no network). Acceptable; if it ever matters, a separable refinement is teaching `isTokenExpiringSoon()` to return false when a configured, not-known-invalid CI token is the presented credential (mirroring `isAuthenticated`, `SupabaseClient.ts:357-368`). Not required for this fix.
- **Unsigned-in relay route cannot exist:** `resolveClientCredential` throws `'Unable to authenticate with server…'` when no relay token is available (`ModelHandler.ts:505-510`), so the gate never sees a relay client without a credential source.
- **Handlers that don't tag routes** (`vscodelm` builds no credentialed SDK client): route reads `undefined` → gate closed → status quo (its proactive rebuilds never refreshed anything either); reactive recovery unchanged.
- **Offline relay user near expiry:** per-invocation failed _refresh attempts_ replace today's per-invocation _rebuilds_; each attempt is bounded and the model call itself is failing in this scenario. Optional follow-up hardening (not part of this fix): a failure cooldown inside `SupabaseSessionCoordinator.getFreshSession`, benefiting all callers.
- **Mid-run model switch:** covered by the getter's live rebinding (table above).
- **Token counting and other `getClient()` callers** do not pass through `withAbortController` (sole caller: `ModelInvocationNode.ts:133`), so they gain no new overhead; relay-route `getClient()` calls there already refresh near-expiry sessions themselves.

## Test plan

All Vitest, host-neutral, under `src/test-kernel/` per repo convention.

1. **`src/test-kernel/agent/runtime/RetryState.vitest.ts`** (existing suite; the regression home):
   - Expose the harness: add a public `runWithAbort(op)` passthrough on `ExposedRetryNode` and a `clientCredentialRoute` field on `TestRetryServices` / `createRetryNode`. Seed expiry with `SupabaseClient.setTokenExpiry(...)`; reset with `SupabaseClient.resetForTests()` in `afterEach`.
   - **Symptom regression:** `it.each(['api-key', 'openrouter', 'chatgpt-subscription', undefined])` — expiring token + non-relay route → `refreshClient` spy **not called**, operation result passes through.
   - **Relay happy path:** route `'relay'`, expiring token, fake `AuthTokenProvider` (`setAuthProvider({ whenReady, ensureFreshToken, getSessionTokens })`, interface at `src/auth/TokenProvider.ts:7-11`) whose `ensureFreshToken` simulates rotation by calling `SupabaseClient.setTokenExpiry(Date.now() + 3_600_000)` → `refreshClient` called **once**, operation ran.
   - **Rotation gate:** route `'relay'`, expiring token, provider returns the stale token without updating expiry → `refreshClient` **not called**, operation still attempted (reactive path remains the net).
   - **Fresh token:** route `'relay'`, expiry an hour out → no `refreshClient`, and `ensureFreshToken` never invoked (proves no hot-path auth traffic).
2. **`src/test-kernel/auth/SupabaseClient.vitest.ts`** (existing suite): pin `isTokenExpiringSoon()` — null expiry → false; `now + 1h` → false; `now + 60s` → true. It currently has zero direct coverage and the gate depends on its exact semantics.
3. **`src/test-kernel/agent/modelHandlers/ModelClientRouteSnapshot.vitest.ts`** (existing `withModelClient` suite): the `clientCredentialRoute` getter reflects the stubbed handler's route for the current client and **rebinds** after `refreshClient` swaps the client (stub supplies `getCredentialRouteForClient`, same `as unknown as IModelHandler` pattern already used there).
4. Optional: a base-class test that `getCredentialRouteForClient` returns the route passed to `rememberClientCredentialRoute` and `undefined` for foreign clients (home: `src/test-kernel/agent/modelHandlers/`).

**Verify:** `npm run typecheck`, `npm run lint`, targeted
`npx vitest run src/test-kernel/agent/runtime/RetryState.vitest.ts src/test-kernel/auth/SupabaseClient.vitest.ts src/test-kernel/agent/modelHandlers/ModelClientRouteSnapshot.vitest.ts`,
then full `npm test`.

## Risks and mitigations

- **Getter snapshotting.** If a future caller spreads the `withModelClient` result, `clientCredentialRoute` snapshots — the identical, already-documented hazard as the existing `client` getter (`CycleServices.ts:44-51`). No new hazard class; the fix leans on the standing discipline rather than inventing a new channel.
- **Implicit-behaviour whiplash for relay users.** Log volume drops from spam to one line per expiry window — that is the intended effect, but anyone dashboarding on those debug lines should expect the change.
- **Reliance on `getFreshSession`'s threshold** being the same 30 minutes (`SupabaseAuthCoordinator.ts:54` passes `TOKEN_REFRESH_THRESHOLD_MS` through) — it is, so `getRelayAccessToken()` always refreshes when the gate is open. If the two thresholds ever diverge, the worst case is a skipped rebuild (reactive path covers), never a loop.
- **Per-invocation refresh attempts while offline** (relay route, failed refresh): bounded, overshadowed by the failing model call itself; optional coordinator-side cooldown noted as follow-up, deliberately not bundled to keep this change minimal.

## Why this is the cleanest fix

The defect is a guard whose termination mechanism exists on exactly one route but fires on all of them. A′ closes that gap at the narrowest possible seam: the route fact already exists (recorded at client construction), the port already has a one-line mechanism to expose it (`Pick`), the services bridge already has a live-getter discipline to carry it, and the auth layer already has the threshold-gated refresh to call. Each piece is used for its existing purpose; the only new code is the plumbing of one fact and an honest rebuild condition. Relay users keep — and gain an explicit, tested version of — their protection; personal-key users get silence; the CI path is untouched; and the retry layer ends up knowing _less_ about auth than the bug made it pretend to know.
