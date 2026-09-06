# Survey: code consolidation and native-method opportunities (2026-09-06)

> **Status:** Written 2026-09-06 against branch HEAD `03d2cfd` (`chore(deps-dev):
> bump the development-dependencies group across 1 directory with 6 updates`,
> #11842). Scheduled routine re-ran the standing question — "find
> duplicate/similar logic to consolidate, and hand-rolled code that a native
> method or the standard library already covers" — three days after
> `2026-09-05-consolidation-and-native-methods-survey.md`. **Verdict: one
> candidate clears the bar and is fixed in this pass.** `packages/cli/src/chat/tui/state/sessionView.ts`'s
> `viewSignal` reimplemented `toSignal` from `src/shared/signals.ts` line for
> line, in a package that already imports three other helpers from that exact
> module. Consolidated: `viewSignal` now calls `toSignal`, and the
> undefined-array guard one of the two copies had drifted in is folded into
> the shared implementation so both call sites get it.

## 0. Window covered

`05b6cd3..03d2cfd` was this pass's window (the prior entry's grounding
commit to today). 15 commits touched `src/` or `packages/*/src/` in that
span, dominated by one large, tracked feature: "one fold, three renderers"
(PRD `docs/prds/2026-09-03-prd-one-fold-three-renderers.md`, lanes 1-5 and 8,
landing across #11881, #11883, #11884, #11894, #11896, #11897, #11909,
#11910, #11912, #11913, #11915, #11916) plus its immediate follow-up
cleanups. This is exactly the shape prior entries in this series flag as the
highest-yield place to look: a large feature landing across many files in a
short window is the classic source of copy-pasted wiring, and the PRD itself
documents the `toSignal`-shaped pattern this pass found duplicated
(`docs/prds/2026-09-03-prd-one-fold-three-renderers.md:1503-1507`).

## 1. Method

Same tells as the 2026-08-29 through 2026-09-05 entries: repo-wide `rg`
sweeps of `src/` and `packages/*/src/` (production code only, `test-kernel`
and `.vitest.ts` excluded) for `.hasOwnProperty(`, hand-rolled
`setTimeout`-based sleeps, `JSON.parse(JSON.stringify(` deep clones,
`.indexOf(...) !== -1`, `.filter` + `.indexOf` dedup, hand-rolled
`Math.random().toString(36)` IDs, hand-rolled `isEqual`/`deepEqual`,
hand-rolled attempt-counter loops, hand-rolled `debounce`/`throttle`, new
`Object.assign(` call sites, `arr[arr.length - 1]` instead of `.at(-1)`, and
mutating `.sort(` on arrays this pass didn't already own. Then `git
diff 05b6cd3..HEAD -- src packages/*/src` to separate newly-introduced hits
from pre-existing, already-adjudicated ones.

## 2. What was found

**`packages/cli/src/chat/tui/state/sessionView.ts`'s `viewSignal` duplicated
`src/shared/signals.ts`'s `toSignal`.** The `Object.assign(` sweep surfaced
three new call sites in the window; two were in production code
(`src/shared/signals.ts:36`, `packages/cli/src/chat/tui/state/sessionView.ts:54`
pre-fix), one in `src/test-kernel/agent/progressTestUtils.ts` (out of this
survey's scope). Reading the two production hits side by side showed they
were the same function:

```ts
// src/shared/signals.ts — toSignal (pre-existing)
const s = signal(initial);
const fiber = runtime.runFork(
  Stream.runForEachArray(changes, (arr) =>
    Effect.sync(() => { s.set(arr.at(-1) as A); }),
  ),
);
return Object.assign(s, { dispose: () => { runtime.runFork(Fiber.interrupt(fiber)); } });

// packages/cli/.../sessionView.ts — viewSignal (new in this window, #11881)
const s = signal(SubscriptionRef.getUnsafe(view));
const fiber = runtime.runFork(
  Stream.runForEachArray(SubscriptionRef.changes(view), (values) =>
    Effect.sync(() => {
      const last = values.at(-1);
      if (last !== undefined) s.set(last);
    }),
  ),
);
return Object.assign(s, { dispose: () => { runtime.runFork(Fiber.interrupt(fiber)); } });
```

`viewSignal`'s three call-site arguments (`effectRuntime()`,
`SubscriptionRef.changes(view)`, `SubscriptionRef.getUnsafe(view)`) map
directly onto `toSignal<A>(runtime, changes, initial)`'s parameters —
`effectRuntime()`'s return type (`ManagedRuntime.ManagedRuntime<never,
never>`, `src/platform/processRuntime.ts:10`) is the exact type `toSignal`
declares for its `runtime` parameter, and `viewSignal`'s declared return
type (`Signal.State<SessionView> & { dispose: () => void }`) is `toSignal`'s
own exported `StreamSignal<SessionView>` alias spelled out by hand. This
was a genuine drop-in duplicate, not a superficial lookalike, and it landed
in a package that already imports `subscribeToSignalChanges` from this same
`@shared/signals` module in four other files
(`packages/cli/src/chat/tui/terminalTitle.ts`,
`packages/cli/src/chat/tui/runChatTui.tsx`,
`packages/cli/src/chat/tui/state/subscribeApprovals.ts`,
`packages/cli/src/chat/tui/state/useSignal.ts`) — so the shared module was
already a normal dependency for this file, just not used for this one
function.

The two copies had also already drifted: `toSignal` set
`s.set(arr.at(-1) as A)` unconditionally, silently writing `undefined` cast
as `A` if a drained array were ever empty, while `viewSignal` guarded with
`if (last !== undefined) s.set(last)`. `Stream.runForEachArray` chunks are
not expected to be empty in this codebase's usage, so the two
implementations behaved the same in practice, but the type-unsound cast in
`toSignal` was exactly the kind of latent silent-degradation risk
`CLAUDE.md`'s "Silent degradation is a defect" guardrail flags — nothing
enforces it stays that way as the two extra pre-existing `toSignal` call
sites (`packages/extension/src/progressView/frontend/sessionTransport.ts:168,173`)
evolve.

## 3. Fix

- `src/shared/signals.ts`: `toSignal` now guards the same way `viewSignal`
  did (`const last = arr.at(-1); if (last !== undefined) s.set(last);`),
  removing the unsound cast and making both existing call sites
  (`sessionTransport.ts`'s `view$`/`host$`) strictly safer with no behavior
  change (neither passes a stream whose values are legitimately
  `undefined`).
- `packages/cli/src/chat/tui/state/sessionView.ts`: `viewSignal` now reads

  ```ts
  function viewSignal(
    view: SubscriptionRef.SubscriptionRef<SessionView>,
  ): StreamSignal<SessionView> {
    return toSignal(
      effectRuntime(),
      SubscriptionRef.changes(view),
      SubscriptionRef.getUnsafe(view),
    );
  }
  ```

  dropping the now-unused `Effect`, `Fiber`, and `Stream` imports (`signal`
  stays, for the module's own `bound` signal) and the hand-spelled
  `Signal.State<SessionView> & { dispose: () => void }` return-type literal
  in favor of the shared `StreamSignal<SessionView>` alias.

Verified: `npm run typecheck:cli` and `npm run typecheck:workspace` (which
covers `packages/extension/src/**` per its root `tsconfig.json`, so both
existing `toSignal` call sites type-checked against the new signature) both
pass clean; `npx eslint --fix` on the two touched files fixed one
import-order violation and left zero lint errors; `npx prettier --check`
passes; `npm run check:dead-code-ratchet` reports no new findings;
`npx vitest run signals sessionView` and the full `npm test` suite pass.

## 4. What was checked and ruled out

- **Hand-rolled sleeps, `.hasOwnProperty()`, `JSON.parse(JSON.stringify(`,
  `.indexOf(...) !== -1`, `.filter` + `.indexOf` dedup, hand-rolled
  `Math.random().toString(36)` IDs, hand-rolled `isEqual`/`deepEqual`,
  hand-rolled attempt-counter loops, hand-rolled `debounce`/`throttle`:**
  zero new hits in the window; the same pre-existing, already-adjudicated
  instances the 2026-09-02 through 2026-09-05 entries recorded (none
  touched by this window's commits per `git log 05b6cd3..HEAD -- <file>`).
- **`arr[arr.length - 1]` instead of `.at(-1)`:** zero new hits.
- **New `Object.assign(` call sites beyond the one fixed above:** the third
  window hit, `src/test-kernel/agent/progressTestUtils.ts`, is test-kernel
  code, outside this survey's declared production-code scope (consistent
  with every prior entry's stated method).
- **New mutating `.sort(` call sites:** eleven hits in the window
  (`streamOrdering`/`attention`-adjacent code in the fold's session-view
  layer), all sorting an array the function just built locally (a fresh
  `.push()`-populated array, a `[...iterable]` spread, or a
  `[...owned.childIds]` spread before mutation) — none mutate a shared or
  caller-owned array in place. Same "owned, function-local" shape the
  2026-08-29 and 2026-09-05 entries already accepted for `Object.assign`;
  not a candidate.

## 5. Verdict

The `05b6cd3..03d2cfd` window's dominant diff (the one-fold-three-renderers
feature) produced one genuine, fixable duplication — `viewSignal` against
`toSignal` — caught by the same `Object.assign(` tell this series has swept
every round, this time landing on a real hit instead of a pre-existing,
already-accepted one. It is fixed in this pass, verified by typecheck,
lint, format, the dead-code ratchet, and the full test suite. Everything
else the standing sweep checks remains clean or unchanged from the prior
six rounds.
