# Proactive Token Refresh — Route-Aware Credential Freshness (Tournament Entry)

**Status:** Design proposal. No source changes; every claim below was verified
against current source and is cited `file:line`. Line numbers drift — anchor
on clause text.
**Scope:** The proactive pre-invocation token-refresh path in the agent retry
machinery: `src/agent/core/flows/RetryState.ts`,
`src/agent/core/flows/CycleServices.ts`,
`src/agent/core/flows/ModelInvocationNode.ts`,
`src/agent/modelHandlers/ModelHandler.ts`,
`src/agent/types/IModelHandler.ts`, `src/auth/SupabaseClient.ts`,
`src/auth/SupabaseSession.ts`. The reactive relay-401 recovery is discussed but
not changed.
**Related:** [`lifecycle-status-ownership.md`](./lifecycle-status-ownership.md)
— its ownership inventory (line 120) already names this exact seam as
misplaced credential policy and designates the injected `refreshClient`
boundary as the right home. This proposal is that recommendation applied to
the proactive path.

## TL;DR — verdict

The proactive check in `RetryableInvocationNode.withAbortController` decides
"refresh the model client" from **global session state with no knowledge of
which credential the call actually presents**. In personal-key mode the
rebuild never touches the relay token, so the checked condition never clears
and the branch fires on every model invocation for the whole 30-minute
threshold window — the reported log loop. The cleanest fix is **Candidate C:
push freshness down into the credential layer**. `ModelHandler` — the only
component that knows a client's credential route — gains a narrow
`ensureFreshClient(client)` that no-ops for non-relay routes and rebuilds a
relay client **only when the underlying session token actually rotated**.
`RetryState` calls it blindly through the existing injected-services bridge
and stops gating on `SupabaseClient` state for the proactive path. Relay
protection is preserved (strengthened: it becomes explicit instead of a
rebuild side effect), personal-key users never rebuild, no network probe is
added to the hot path, and the loop cannot restart in any mode — including
the CI-token and offline variants that route-gating alone (Candidate A)
leaves alive.

## Problem statement

User log, personal-key mode: before nearly every model invocation,

```
Token nearing expiry, refreshing client proactively
Refreshed model client proactive pre-invocation
```

repeats every few seconds for up to ~30 minutes, and each occurrence rebuilds
the provider SDK client. An agent turn issues many invocations (round calls,
subagent calls, follow-ups — each is a `ModelInvocationNode` exec, the only
caller of `withAbortController`), so the pair floods the log and churns
clients for the entire threshold window.

## Root-cause evidence

The loop, step by step, with the exact seam where each link breaks:

1. **A route-blind gate on global session state.**
   `RetryableInvocationNode.withAbortController`
   (`src/agent/core/flows/RetryState.ts:188-198`) runs before every model
   invocation:

   ```ts
   // Proactive relay token refresh before the request
   if (SupabaseClient.isTokenExpiringSoon()) { ... await tryRefreshClient(...) }
   ```

   `isTokenExpiringSoon()` (`src/auth/SupabaseClient.ts:92-97`) is true when
   the cached **session** expiry `tokenExpiresAt` is within
   `TOKEN_REFRESH_THRESHOLD_MS = 30 * 60 * 1000`
   (`src/auth/config.ts:260-261`). `tokenExpiresAt` is written by the auth
   layer whenever a session is stored or loaded
   (`src/auth/SupabaseAuthCoordinator.ts:59-60`,
   `packages/extension/src/frontend/auth/SupabaseAuthProvider.ts:203`,
   `SupabaseClient.setTokenExpiry` at `src/auth/SupabaseClient.ts:83-85`) —
   **regardless of which credential the model uses**. The doc comment
   (`SupabaseClient.ts:87-91`) claims it "Returns false if no expiry is
   tracked (e.g., not authenticated **or not using relay**)" — the "not using
   relay" half is aspirational; nothing clears or conditions the cached expiry
   on the model's credential route.

2. **The proactive branch rebuilds but never refreshes.** The branch only
   calls `services.refreshClient` — bridged by `withModelClient`
   (`src/agent/core/flows/CycleServices.ts:52-72`) to
   `ModelHandler.refreshClient()` (`src/agent/modelHandlers/ModelHandler.ts:1025-1030`)
   → `getClient(selection)`. Only the reactive relay-401 path
   (`RetryState.ts:136`) calls `SupabaseClient.getRelayAccessToken(true)`.

3. **In personal-key mode the rebuild cannot clear the condition.**
   `resolveClientCredential` (`ModelHandler.ts:477-568`) touches Supabase only
   in the `useRelay` branch (`ModelHandler.ts:498-530`, the
   `SupabaseClient.getRelayAccessToken()` call at line 505). A personal-key or
   OpenRouter client build takes the non-relay tail (`ModelHandler.ts:539-567`)
   and reads the key from secrets — it never refreshes the session and never
   updates `tokenExpiresAt`. Route type:
   `src/agent/types/ModelHandlerContracts.ts:34-36`
   (`ModelCredentialRoute = 'api-key' | 'chatgpt-subscription' | 'openrouter' | 'relay'`);
   per-client routes are tracked in the `clientCredentialRoutes` WeakMap
   (`ModelHandler.ts:201-204`) and consumed in `createResponse`
   (`ModelHandler.ts:1059-1062`).

4. **So the gate sticks true.** Once the signed-in session enters its last 30
   minutes, condition (1) holds for every invocation while the mode in (3)
   guarantees nothing resets it. The loop ends only when an external actor
   refreshes the session (the VS Code authentication provider's `getSessions`
   re-validation, `SupabaseAuthProvider.ts:203-212`) or the user signs out —
   up to ~30 minutes of rebuild spam, matching the report.

5. **Relay mode works today only by side effect.** For a relay-routed client,
   the rebuild re-resolves the credential → `getRelayAccessToken()` →
   `ensureFreshToken()` → `getFreshSession()`, which itself refreshes
   proactively inside the threshold (`src/auth/SupabaseSession.ts:249-254`)
   and stores the result (`SupabaseSession.ts:81-86` → `onTokenExpiryChanged`
   → `setTokenExpiry`). The protection relay users actually get is an
   undocumented consequence of client construction — and it is absent in two
   variants where today's loop also spins:
   - **CI relay token + stored session:** `getRelayAccessToken()` returns the
     static `TEXRA_RELAY_TOKEN` from its cache-only branch
     (`SupabaseClient.ts:229-245`, `src/auth/relayToken.ts:42-48`) without
     refreshing the session — `tokenExpiresAt` stays stale forever.
   - **Offline relay:** the proactive session refresh fails and the
     stale-but-valid session is returned (`SupabaseSession.ts:261-272`) —
     `tokenExpiresAt` stays stale; the rebuild churn continues.

Two hard constraints the fix must respect fall out of the same code:

- `forceRefresh` on a configured CI token marks it rejected
  (`SupabaseClient.ts:231-237` → `markRelayTokenRejected`,
  `relayToken.ts:104-106`). That is correct for the reactive path (a 401 is
  authoritative evidence) and must **not** be triggered by any proactive
  branch — ruling out a naive "call `getRelayAccessToken(true)` proactively".
- No new network probes on the model-call hot path — the cache-only comment
  at `SupabaseClient.ts:238-244`. The sync in-memory expiry gate
  (`SupabaseClient.ts:88-89`) exists precisely so the hot path can check
  freshness for free.

## Chosen design — Candidate C: credential freshness behind the injected client boundary

One sentence: **the component that captured the credential decides whether
the client is stale; the retry layer just asks.**

`ModelHandler` alone knows the route (it built and tagged the client), it
already imports `SupabaseClient`, and it owns credential resolution. So the
route check, the expiry check, and the rebuild-if-changed decision all move
there. `RetryState` keeps a single blind call through the services bag. This
is exactly the "right home" `lifecycle-status-ownership.md` (line 120)
pre-designated: _"the 401-refresh policy moves behind that injected boundary
(model-handler/client layer); RetryState keeps only 'ask the client to
refresh, retry once'."_

The contract of the new method is deliberately stronger than "refresh":

> **Rebuild iff the credential captured inside this client differs from a
> fresh resolution.** A no-change result returns the _same instance_.

That invariant is what kills every loop variant, not just the reported one.

### File-by-file changes

#### 1. `src/agent/modelHandlers/ModelHandler.ts` — own the freshness decision

Record the captured credential alongside the route (value type of the
existing WeakMap grows an optional field; the map name and registration
helper stay):

```ts
private readonly clientCredentialRoutes = new WeakMap<
  object,
  { readonly route: ModelCredentialRoute; readonly apiKey?: string }
>();

protected rememberClientCredentialRoute<Candidate extends object>(
  client: Candidate,
  route: ModelCredentialRoute,
  apiKey?: string,                       // NEW — relay clients pass credential.apiKey
): Candidate {
  this.clientCredentialRoutes.set(client, { route, apiKey });
  return client;
}
```

Add the public freshness method (concrete, base-class only — no subclass
work; it sits next to `refreshClient` at `ModelHandler.ts:1025-1030`):

```ts
/**
 * Return the client to use for the next invocation: the same instance while
 * its captured credential is current, a freshly built one only when the
 * relay session token underneath it rotated.
 *
 * Only 'relay'-routed clients can go stale mid-run — their credential is the
 * Supabase session token. Personal-key/OpenRouter clients capture static
 * secrets, ChatGPT-subscription clients resolve their OAuth token per build
 * (coordinator-owned), and clients with no recorded route (vscode-lm) manage
 * their own auth — all return unchanged without touching auth state.
 *
 * Hot-path safe: the expiry gate is synchronous and in-memory; the only
 * network call is the session refresh inside getRelayAccessToken →
 * ensureFreshToken, which fires at most once per threshold window.
 */
async ensureFreshClient(client: C): Promise<C> {
  if (typeof client !== 'object' || client === null) return client;
  const captured = this.clientCredentialRoutes.get(client);
  if (captured?.route !== 'relay') return client;
  if (!SupabaseClient.isTokenExpiringSoon()) return client;

  const currentToken = await SupabaseClient.getRelayAccessToken();
  // Unchanged credential: a static CI relay token, or an offline session
  // that is stale but not yet expired — rebuilding would capture the same
  // value. null means no relay credential at all (offline-expired): keep the
  // stale client and let the call produce a real relay 401 for the reactive
  // path, preserving today's "proactive path never throws" semantics.
  if (currentToken === null || currentToken === captured.apiKey) {
    return client;
  }
  this.logger.debug('Relay session token rotated; rebuilding model client.');
  return this.refreshClient(); // honors subclass overrides (Google cache drop)
}
```

Two mechanical adjustments in the same file:

- `createResponse`'s route lookup (`ModelHandler.ts:1059-1062`) becomes
  `this.clientCredentialRoutes.get(options.client)?.route`.
- The six route-registration call sites that resolve via
  `resolveClientCredential` pass the captured key:
  `src/agent/modelHandlers/anthropic/modelHandlerAnthropic.ts:264`,
  `src/agent/modelHandlers/openai/modelHandlerOpenAI.ts:256`,
  `src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts:1158`,
  `src/agent/modelHandlers/openrouter/modelHandlerOpenRouterNative.ts:169`,
  and the two Google `rememberRoute` callbacks
  (`src/agent/modelHandlers/google/modelHandlerGoogleGenAI.ts:184-185`,
  `modelHandlerGoogleInteractions.ts:~551`) — each a one-argument addition
  (`credential.apiKey`). The Codex registration
  (`modelHandlerCodex.ts:320-328`, route `'chatgpt-subscription'`) passes
  nothing; its route fails the `!== 'relay'` gate anyway.

Verified coverage: every relay-capable handler registers a route — the seven
registration sites above, with DeepSeek/Kimi/GLM/DashScope/MiniMax/XAI
inheriting the OpenAI-family `createOpenAIClient`
(`modelHandlerOpenAIResponse.ts:1149-1159`). `modelHandlerVscodeLm.ts:206`
and the validation stub register none, so `captured` is `undefined` and
`ensureFreshClient` degrades to a no-op — under-protection, never spam, for
clients that cannot use relay anyway.

#### 2. `src/agent/types/IModelHandler.ts` — extend the derived port

Add `'ensureFreshClient'` to the `Pick` list (next to `'refreshClient'`,
lines 57-58). Because the port is `Pick<ModelHandler, ...>`, the signature
can never drift from the class. Test doubles cast through `as unknown as
IModelHandler` (e.g. `ModelClientRouteSnapshot.vitest.ts:19`), so the new
required member breaks no existing mock.

#### 3. `src/agent/core/flows/CycleServices.ts` — bridge with live rebinding

`ModelClientServices<C>` (lines 32-38) gains, mirroring `refreshClient`:

```ts
readonly ensureFreshClient?: () => Promise<void>;
```

`withModelClient` (lines 52-72) defines it **on the returned literal**,
rebinding the same closure variable — the liveness contract documented at
lines 44-51 is unchanged and now covers one more method (its doc comment
gains a sentence):

```ts
async ensureFreshClient(): Promise<void> {
  client = await modelHandler.ensureFreshClient(client);
},
```

No-spread discipline is preserved: callers still pass the result straight to
`flow.setServices(...)` (`ToolUseCycleNode.ts:103`, `ResponseCycleNode.ts:107`).

#### 4. `src/agent/core/flows/RetryState.ts` — go blind

`RetryableNodeServices` (lines 59-67) gains `ensureFreshClient?: () => Promise<void>;`
(optional, like `refreshClient` — test services without it simply get no
proactive freshness). The proactive block at lines 188-198:

```diff
-    // Proactive relay token refresh before the request
-    if (SupabaseClient.isTokenExpiringSoon()) {
-      services.logger.debug(
-        'Token nearing expiry, refreshing client proactively',
-      );
-      await tryRefreshClient(
-        services.refreshClient,
-        services.logger,
-        'proactive pre-invocation',
-      );
-    }
+    // Proactive credential freshness. The credential layer owns the
+    // decision: non-relay routes no-op, and a relay client is rebuilt only
+    // when its session token actually rotated — so this runs before every
+    // invocation without spinning or probing the network. Failures fall
+    // through to the reactive relay-401 recovery below.
+    try {
+      await services.ensureFreshClient?.();
+    } catch (freshnessError) {
+      services.logger.warn('Proactive credential freshness check failed', {
+        data: freshnessError,
+      });
+    }
```

Deliberately _not_ reusing `tryRefreshClient` here: that helper logs a
success line per call (`RetryState.ts:88`), which would re-create the spam
with a different message. The handler logs only when it actually rebuilds.
`ModelInvocationNode`'s `InvocationServices` (`ModelInvocationNode.ts:60-67`)
gains the same optional field so its "only what this node and its base read"
doc stays accurate.

**Not changed:** the reactive relay-401 path (`RetryState.ts:128-173`,
including the `getRelayAccessToken(true)` force-refresh at line 136 and its
CI-token rejection semantics), manual-retry refresh (lines 256-283), and
`refreshClient` itself. `RetryState` keeps its `SupabaseClient` import for
the reactive path only; removing it entirely is the follow-up named in
`lifecycle-status-ownership.md`, out of scope here.

### Why the loop cannot restart — per-mode analysis

| Mode                                                    | Gate path                                                                                                                                     | Result                                                                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal key / OpenRouter (signed in, session expiring) | route gate: `captured.route !== 'relay'`                                                                                                      | **No-op, every invocation.** Symptom dead at the first line that matters.                                                                                        |
| Not signed in                                           | `tokenExpiresAt === null` → route/expiry gates                                                                                                | No-op (double-guarded).                                                                                                                                          |
| Relay + session, online, entering window                | expiry gate → `getRelayAccessToken()` → session refresh (`SupabaseSession.ts:249-254`) → token differs                                        | **Rebuild exactly once** with the fresh token; `setTokenExpiry` closes the gate. Protection is now explicit, not a rebuild side effect.                          |
| Relay + CI token + stored session expiring              | expiry gate → cache-only CI branch → token equal                                                                                              | Same instance, no rebuild, no network, no log. Loop variant (5) dead.                                                                                            |
| Relay + offline, inside window                          | refresh fails → stale-but-valid token returned (`SupabaseSession.ts:261-272`) → token equal                                                   | Same instance; call proceeds with the still-valid token. Loop variant (5) dead.                                                                                  |
| Relay + offline, past expiry                            | `getRelayAccessToken()` → `null`                                                                                                              | Same instance → real relay 401 → reactive path → refresh fails → persistent-401 → manual retry prompt. One clear auth error instead of rebuild churn.            |
| Mid-run model switch                                    | `refreshClient(selection)` builds the new client and records its route; the next `ensureFreshClient` reads the _new_ client's captured record | Freshness tracking follows the switch automatically.                                                                                                             |
| ChatGPT subscription (Codex)                            | route `'chatgpt-subscription'`                                                                                                                | No-op; token freshness stays coordinator-owned (`modelHandlerCodex.ts:332-335`). (Today's code pointlessly rebuilds these clients on _Supabase_ session expiry.) |
| Parallel subagent flows                                 | each flow has its own `withModelClient` closure; session refresh is deduped by `refreshPromise` (`SupabaseSession.ts:198-224`)                | At most one refresh in flight; no thundering herd.                                                                                                               |

No new network probe appears on any path: the only added call,
`getRelayAccessToken()`, is cache-only for CI tokens (by design,
`SupabaseClient.ts:238-244`) and otherwise performs the session refresh the
relay path already performs — at most once per threshold window, and only
after the sync in-memory gate fires.

## Alternatives evaluated

Criteria: **(1) correctness** — relay protected, personal-key never rebuilds
needlessly, no hot-path probes; **(2) separation of concerns**;
**(3) minimalism**; **(4) convention fit / testability**.

| Candidate                                                                   | (1) Correctness                                                                                                              | (2) Separation                                                                           | (3) Minimalism                                             | (4) Fit                                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **C — credential-layer freshness (winner)**                                 | All loop variants dead; relay protection explicit                                                                            | Credential policy owned by the credential layer                                          | ~50 net LOC across 4 files + 6 one-arg call-site additions | Matches the documented target seam; testable via existing vitest patterns                   |
| A — route-gated check in RetryState                                         | Reported symptom fixed; CI-token and offline-relay loops survive                                                             | Worse: route knowledge must leave the handler while auth policy stays in the retry layer | Smallest diff (~15 LOC)                                    | Cements the two-owner split flagged at `lifecycle-status-ownership.md:120`                  |
| B — proactive branch actually refreshes (`getRelayAccessToken()` + rebuild) | Personal-key loop self-terminates; CI+session and offline loops survive; refreshes a session personal-key calls don't use    | Worst: retry layer now does token rotation _and_ client rebuild                          | Small (~15 LOC)                                            | Must avoid `forceRefresh=true` (CI-token rejection) — an invisible trap for the next editor |
| D — delete the proactive path                                               | Relay runs survive via reactive 401 recovery, at the cost of one failed call per expiry window                               | Unchanged (reactive path keeps the import)                                               | Negative LOC — the smallest                                | Deletes a deliberately added protection (`RetryState.ts:188`)                               |
| E — latch/debounce (≤1 refresh per N min)                                   | Spam rate-limited, not fixed: personal-key users still rebuild every N min; the latch can skip the one refresh that mattered | Unchanged                                                                                | ~5 LOC                                                     | Encodes "this check is wrong" as a permanent rate limit                                     |

**Why A loses.** It fixes only the mode that was reported. The gate
`route === 'relay' && isTokenExpiringSoon()` still sticks true whenever the
rebuild cannot refresh the session — CI token (cache-only branch) and offline
(failed refresh, stale token returned) — so the rebuild loop persists in both
variants. And it plumbs route knowledge _up_ into the retry layer instead of
pushing the decision _down_, deepening the exact information leak that caused
the defect: the retry layer would now know about routes _and_ tokens.

**Why B loses.** With `forceRefresh=false` (mandatory — `true` would mark a
configured CI token rejected without a 401, `SupabaseClient.ts:231-237`), the
personal-key loop self-terminates because the session refresh updates
`tokenExpiresAt`. But for a configured CI token the call returns from the
cache-only branch without touching the session, and offline the refresh keeps
failing — in both, the gate stays true and the branch keeps rebuilding every
invocation. It also performs session refreshes for users whose model call
never presents the session token, and it makes the retry layer a second
owner of token-rotation policy. Same leak, wetter floor.

**Why D loses.** It is honestly arguable — and the strongest of the four.
Relay recovery already exists (`attemptRelay401Recovery`, `RetryState.ts:128-173`),
a mid-stream expiry would not 401 at all (the token is checked at request
start), and each round's `withModelClient` bridge re-resolves the credential
anyway (`ToolUseCycleNode.ts:103`), so the marginal protection is thin. But
the proactive path was added deliberately; deleting it accepts one failed
provider call — possibly a long, expensive one — plus a refresh round-trip
per expiry window, in background/headless mode where a burned retry matters,
and it leans on every provider's 401 being classified `isRelayError`
correctly. C preserves the protection _explicitly_ for ~50 LOC, so the
trade-off D asks for is unnecessary. If the tournament valued deletion above
all, D is the fallback; it does not win on the stated criteria.

**Why E loses.** It is a symptomatic rate limit over a root cause it
declares unfixable. Personal-key users still rebuild periodically for no
reason; relay users get an arbitrary cadence that can skip the refresh that
would have saved the run (they silently fall back to the reactive path,
making the latch pure overhead); the misplaced auth knowledge stays. It is
the only candidate that cannot, even in principle, make the log true.

## Test plan

All tests are Vitest under `src/test-kernel/`, alongside the existing
`src/test-kernel/agent/runtime/RetryState.vitest.ts` and the
`src/test-kernel/agent/modelHandlers/` suite. Static auth state is controlled
through `SupabaseClient.setTokenExpiry(...)` / `resetForTests()`
(`SupabaseClient.ts:54-62, 83-85`); `getRelayAccessToken` is spied per case.

**`src/test-kernel/agent/modelHandlers/EnsureFreshClient.vitest.ts` (new)** —
probe subclass in the `GoogleClientRefresh.vitest.ts` style, exposing
`rememberClientCredentialRoute` and a counting `refreshClient`:

1. Personal-key route + session expiring → same instance returned,
   `getRelayAccessToken` never called, `refreshClient` never called.
2. Relay route + session _not_ expiring → same instance, no rebuild.
3. Relay route + session expiring + rotated token → `refreshClient` called
   once, replacement returned.
4. Relay route + session expiring + unchanged token (CI static token) → same
   instance, no rebuild — the loop-killer regression for variant 5a.
5. Relay route + session expiring + `getRelayAccessToken()` → `null`
   (offline-expired) → same instance, does not throw.
6. Client with no recorded route → same instance (safe degradation).
7. `createResponse` still reads the route after the WeakMap value-type change
   (pins the `?.route` adjustment).

**`src/test-kernel/agent/modelHandlers/ModelClientRouteSnapshot.vitest.ts`
(extend)** — bridge semantics, mirroring its four `refreshClient` cases:

8. `services.ensureFreshClient()` rebinds `services.client` when the handler
   returns a replacement; keeps identity when the same instance is returned
   (live-rebinding through the literal — the CycleServices.ts:44-51
   contract).

**`src/test-kernel/agent/runtime/RetryState.vitest.ts` (extend)** — via a
`withAbortController` passthrough on `ExposedRetryNode`:

9. The operation runs after `services.ensureFreshClient` resolves
   (ordering), with no `refreshClient` call on the proactive path.
10. A rejecting `ensureFreshClient` logs a warning and the operation still
    runs — today's "proactive path never throws" semantics
    (`RetryState.ts:86-95` behavior preserved).
11. Services without `ensureFreshClient` invoke the operation untouched
    (unsigned-in/personal-key regression: no Supabase consult at all).

**Unchanged suites that must stay green:** `GoogleClientRefresh.vitest.ts`
(Google `refreshClient` cache-drop overrides, which `ensureFreshClient`
routes through), `ModelClientRouteSnapshot.vitest.ts` (existing four cases),
the full `RetryState.vitest.ts` (reactive-401 and manual-retry paths
untouched).

## Risks

- **R1 — registration drift.** A future relay-capable handler that forgets
  `rememberClientCredentialRoute` silently loses proactive protection
  (no-op), it does not gain spam. Mitigation: registration is already the
  single documented construction step; the no-op path is the safe direction.
- **R2 — incidental key pickup disappears.** Today a personal-key user who
  rotates a key mid-run _might_ have it picked up by the spam rebuild. That
  was never a contract: the documented pickup path is manual retry
  (`RetryState.ts:267-272`), which is unchanged.
- **R3 — port surface growth.** `IModelHandler`'s `Pick` gains a required
  member; verified that existing doubles cast (`as unknown as`,
  `as never`), so nothing breaks. `npm run typecheck` proves it.
- **R4 — behavior change is user-visible in one place:** the two debug log
  strings disappear, replaced by a single debug line on actual rotation and
  a warning on failure. Debug-level only; no telemetry contract.
- **R5 — scope discipline.** The reactive 401 force-refresh stays in
  `RetryState`; the full ownership migration (and a per-route freshness
  policy that could one day cover ChatGPT-subscription tokens) is the
  documented follow-up in `lifecycle-status-ownership.md`, deliberately not
  folded into this fix.

## Verification

```bash
npm run typecheck
npm run lint
npm test
```
