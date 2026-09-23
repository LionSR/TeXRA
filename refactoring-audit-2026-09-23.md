# TeXRA refactoring audit — 2026-09-23

Scan of the codebase's largest/messiest implementations, run by five parallel
subagents over the major clusters. **The codebase is fundamentally in good
shape** — the low-hanging shared primitives are already extracted (LLM
transport/stream helpers, `loop/rows.ts`/`runExit.ts`, `handleSharedHostRequest`,
catalog-driven settings, `computeModelOptions` staged pipeline), and debt is
already tracked by ratchets (file-size, effect-migration, refuted-candidates).
What remains is a bounded set of **structural** debt: copy-pasted *orchestration
skeletons* around those good primitives, a handful of god-functions, and
cross-host parallel implementations. Total realistically recoverable: **~1,800–2,600 LOC**.

Everything below was verified by reading the actual files. None overlaps the
already-refused candidates in `config/ratchets/refuted-candidates.json` (those
are narrow Effect-adoption plays).

---

## Prioritized list (ranked by savings ÷ effort)

### 1. Cross-host SettingsView backend — two parallel implementations of one registry
**Save ~350–500 LOC · effort L · highest maintenance burden**

The extension (`SettingsViewMessageHandler.ts` + `handlers/*`) and the desktop
(`desktopSettingsIpc.ts` + `desktop*SettingsController.ts`) are two parallel
assemblies of the *same* `SettingsViewInboundHandlerRegistry`. `updateStateSetting`,
the `SettingsSnapshotPosters` map (9 entries), the GitHub token + PR-subscription
handlers, and the credential-refresh tails ("invalidate usage → post profile/model
→ refresh catalogs → post usage") are duplicated near-verbatim — the desktop code
even carries comments like *"Mirrors the extension's `GitHubSubscriptionHandlers`"*.
This is the worst finding because every settings change must be made **twice** and
silently drifts.

**Approach:** hoist a host-neutral `SettingsViewBackend` (`@controllers/settingsView`)
owning the registry, `updateStateSetting`, the poster map, and the refresh tails,
parameterized by a small host port (`postToRenderer`, dialogs, `unsupported` set,
`refreshCatalogs`, `promptForSecret`). The three `desktop*SettingsController`
classes largely dissolve into that port.

### 2. LLM Chat-SSE streaming driver + `finalizeChatCompletion`
**Save ~380–480 LOC · effort L · largest raw single-cluster savings**

The `streamTurn` orchestration skeleton is copy-pasted across four providers
(`openaiChat.ts` ~560 lines, `openrouterChat.ts` ~440 lines, plus anthropic/google
structurally identical): the `Stream.suspend` → identity-closure → `Stream.unwrap`
→ safeParse/protocol/same-model guard → `pullStream`+`sseEvents` → progress
mapEffect → completion assembly pipeline. The **completion assembly** (the
`finishReason==='tool-calls'` consistency check + the ordinal-validated tool-call
loop + reasoning/message push) is near-verbatim in **all four** providers.

**Approach:** extract a `chatSseStreamTurn(config, {chunkSchema, decodeChunk,
accumulateUsage, buildProviderExtras})` driver; providers supply only schema +
protocol hooks. Separately extract `finalizeChatCompletion(...)` (usable by all
four). The 7-protocol union in `openaiChat` makes the hook boundary the hard part.

*(Same cluster, secondary: the background submit/observe/cancel lifecycle in
`openaiResponses.ts` vs `googleInteractions.ts` is duplicated for another
~130–180 LOC — `boundOperation`, the `chains` guard incl. its comment, the
cancellation-evidence mapping. Pairs naturally with the above.)*

### 3. Run-loop scaffold shared between `toolUse.ts` and `reflection.ts`
**Save ~70–100 LOC dedup + readability · effort M · best LOC/risk ratio**

The two run programs hand-roll the same shell around their family-specific body:
the `latest` Ref + `commit` closure (verbatim), the load→decide resume block
(~13 near-identical lines), the `result()` builder, the `finalize` skeleton, and
the `program.pipe(onExit(finalize), map(result), catchCause(...))` tail (verbatim
modulo the family word).

**Approach:** a `runProgramShell` helper in `loop/` (sibling to the existing
`runExit.ts`, which set the precedent) taking `{openFresh, restore, coordinates,
onFinalize?}`. Fits the "no flow engine / it's a function each `Effect.gen` calls"
guardrail. **Do this first** — cleanest win, unifies the two loops the docs already
describe as "two plain Effect loops."

### 4. CLI transcript-ring duplicate-row defense + statusBar segment factories
**Save ~220–260 LOC · effort S–M**

- `staticTranscriptRing.ts` carries a whole ~150-line subsystem
  (`scanDuplicateRowIds`, `duplicateRowWarningItems`, `logSurvivingDuplicates`,
  a UUID namespace, marker rows) to defend against duplicate row-ids that its
  **own comments say upstream `upsertRow` already guarantees can't happen**.
  Replace with a single dev-mode assertion. *(~130–150 LOC, effort S–M — the
  single lowest-risk win in the whole audit.)*
- `statusBarDisplay.ts` has ~11 near-identical `*Segment` factories and two
  overlapping width-fitters that re-implement the same priority-compact-then-drop
  logic. Collapse the factories into a declarative segment-spec table and unify
  the fitters. *(~90–110 LOC, effort M — behind existing tests.)*

### 5. Shared session/state & controllers — repeated idioms
**Save ~200–280 LOC across five files · effort S–M · cleanest quick wins**

- **`Database.ts`**: `appendPrepared` is a 240-line mega-closure with inline
  inquiry-transition validation (~10 sequential `if…throw`); extract
  `validateInquiryTransition`. Plus ~25 `sql.unsafe<Record<…>>(Q,[…])[0]?.field`
  sites → `exec`/`execOne` helpers. *(~60–90 LOC)*
- **`sessionFold.ts`**: the "compute-all / compare-every-field / return-same-or-new"
  identity-preserving idiom is hand-written 4× → one generic `patchIfChanged(obj,
  patch)`. *(~40–60 LOC)*
- **`runStateFold.ts`**: `foldRow` repeats a `requireOpened` guard 6× and an
  `advance(state, patch)` (bump commit + rowsBeforeSnapshot) spread 9×. *(~40–50 LOC)*
- **`sessionLayer.ts`**: `catch → logWarning → withLogChannel(CHANNEL)` recurs
  6–8× → one `logWarnAndContinue` combinator. *(~25–35 LOC)*
- **`stateSettings.ts`**: ~18 homogeneous catalog entries across 4 categories
  restate identical `slots/category/honoredBy/surfaces` → group builders following
  the existing `PROVIDER_ROUTING_SETTINGS` precedent. *(~40–50 LOC net; keep thin —
  the file is deliberately a scannable catalog.)*

---

## Also-large-but-leave-alone (verified clean)
`computeModelOptions.ts` (staged pipeline), `replacement/rules.ts` (inherent domain
data), `modelBinding.ts` (already table-driven `PROTOCOL_DESCRIPTORS`),
`renderer/main.ts` (irreducible Lit wiring), `SessionComposer.ts` (cohesive,
CSS-heavy), `doctor.ts`/`history.ts` (already factored), `transcriptEntryLayout.ts`
(declarative `ROW_GEOMETRY`).

## Suggested execution order
1. **#3 run-loop shell** — smallest, safest, highest-signal (unifies the two loops).
2. **#5 quick wins** (`runStateFold`, `sessionLayer`, `sessionFold`) — mechanical, low-risk.
3. **#4 transcript-ring** — deletes a whole "can't-happen" defense subsystem.
4. **#1 settings backend** — biggest maintenance-burden win; larger effort.
5. **#2 LLM streaming driver** — biggest raw LOC; largest effort (7-protocol union).

## Notes on effort caveats
Findings #1 and #2 are effort-L for real reasons (concurrency/claim ordering in the
run paths; the openaiChat 7-protocol union). Per the repo's testing discipline
these are behavior-preserving refactors → **zero new tests expected**, validated
against existing suites (`test:changed` → `test:pure` → `npm test`). Each should be
its own PR; none widens a ratchet baseline (they shrink `file-size-baseline`).
