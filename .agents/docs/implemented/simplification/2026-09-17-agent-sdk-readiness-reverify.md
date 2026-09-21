# Agent-SDK readiness — re-verification pass (2026-09-17)

Status: implemented

> **Written 2026-09-17.** The scheduled audit routine re-ran the standing
> question — "review the agent core, model handler, logger, and surface for
> unnecessary abstraction and unready surface; design subagent boundaries" —
> against the immediately prior filed pass
> ([`-09-14`](../../archived/simplification/2026-09-14-agent-sdk-readiness-reverify.md), the "twelfth
> consecutive green", inspected at `d5e95a89`) and the Tier-1 manifest of record
> ([`2026-09-10-agent-sdk-tier-1-manifest.md`](../../proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md)).
> This is the **thirteenth consecutive green pass** (`-08-19` through `-09-17`).
> No `-09-15` or `-09-16` record exists under
> [`implemented/simplification/`](./) — the routine did not file on those days —
> so `-09-14` is the immediately prior pass and the lineage has no gap in
> substance, only in calendar dates. Facts below are re-derived by direct
> inspection at `3d5fbda`, which was the `main` tip when this pass ran. `main`
> has since advanced to `8cd31c2` (#12670), whose two files
> (`packages/cli/src/commands/_helpers/dispatch.ts`,
> `src/shared/session/runStateFold.ts`) are cited nowhere here, so every
> citation holds against that base as well. Each carries a `file:line`, config
> path, or count.

> **Correction note (same-day).** The first draft of this record carried
> `-09-14` §4's "Tier-1 manifest re-enumeration owed" forward as an open item
> without re-deriving it against the live file. It was wrong: the manifest was
> re-enumerated on 2026-09-15 by **#12634** (`0ffbe01`, "docs: re-enumerate
> agent SDK Tier-1 manifest against main"), which landed between `-09-14` and
> this pass. Every surviving `StreamView` / `ExecutionIdSchema` /
> `IModelHandler` / `AgentFinalResult` mention in that document is now either
> its own correction note (lines 16–31), struck through and marked moot
> (`:322`, `:326`), or a historical reference to the landed cutover (`:350`).
> The item is **closed**, and §5 below records it as such. This is the same
> stale-carry-forward failure the `-09-14` record was itself corrected for;
> the lesson is that a carried-forward finding needs re-derivation, not
> transcription.

> **Disposition note.** This record was first filed as "recorded, not acted on"
> under the routine's standing default. The maintainer then asked, in session,
> for the identified problems to be refactored as far as possible. That request
> lifts the default, and §5 records what was acted on; the audit facts above and
> in §§1–4 are unchanged by it.

## 0. Verdict

**The standing structural verdict holds: the codebase is well-aligned with an
Agent-SDK shape, and no speculative refactor is warranted.** Thirteen
consecutive passes (`-08-19` → `-09-17`) reach the same top-line conclusion.
What is new this pass is not the verdict but **two convergent improvements that
landed on their own since `-09-14`**, both moving in the direction the prior
passes named:

- **`-09-14` §5.2 (`turnText` duplication) — resolved, exactly as prescribed.**
  The prior pass flagged that `ModelInvoker.ts` exported `turnText` and
  `helperModel.ts` re-implemented the identical `TurnResult → string` body, and
  prescribed "relocate this pure function to a leaf module … that both import."
  That is what happened: `turnText` now lives in the leaf module
  `src/agent/runtime/run/turnText.ts:4` and is imported by all four call sites —
  `ModelInvoker.ts:90`, `runtime/loop/reflection.ts:119`, `helperModel.ts:24`,
  and `run/compaction.ts:38`. The duplicate re-implementation is gone; no shim
  was left behind. A tracked minor cleanup discharged by convergent PRs, not a
  speculative edit.
- **Host→`@agent` deep-import width shrank again.** Current
  `host-agent-import-baseline.json`: cli **5**, desktop **4**, extension **7**,
  agent (the SDK package) **7**. Against `-09-14` (5 / 4 / **8** / 7),
  **extension shrank 8 → 7**; cli/desktop/agent hold at their floor. The stated
  open work — "shrinking the frozen deep-import lists" — is progressing; no
  baseline widened.

`d5e95a89..3d5fbda` is **174 commits**, **70** of which touch the four audited
areas. (An earlier draft said "50" — a `--since` count taken on a shallow clone
that could not see the range. The figure and the characterization resting on it
are corrected here; the count was re-derived after deepening the clone.) The
range is **not** uniformly cleanup: alongside the refactors it carries fixes
(`e6526295` "report unhandled failures in forked fibers", `697663ef` an approval
fix), CI work (`06e165c6` "fail on unexecuted Effect values"), a dependency bump
(`0c3ae8d5`), and test/doc commits.

What this pass actually inspected is the end state, plus four spot-checked
commits, each net-negative (`6bbfea1` "delete dead BaseFS/RelativeFS layers and
Promise-era shims", −236/+52; `124ec8e` "drop Promise shims over synchronous
run-loop work"; `a87461f` "inline processServicesLayer, make storage roots
data"). The structural conclusion — no new exported class, wrapper layer, or
one-implementor interface in the four audited areas — is an **end-state**
property, resting on the §1 audits and the ratchets that would reject such an
addition, **not** a per-commit review of all 174.

The routine's standing default would have made this a **recorded, not acted on**
pass: a scheduled firing carries no maintainer request, and none of the
carried-forward items is a defect. The maintainer then asked for the identified
problems to be refactored as far as possible, which lifts that default. **Three
of the four carried-forward items are now closed in this PR** (§5.1, §5.2, §5.4)
and the fourth turned out to have been closed already, upstream, before this
pass ran (§5.3 — see the correction note above). The structural verdict is
unaffected: these are the small carried-forward survivors the passes have
tracked for weeks, not a structural refactor, and nothing in §§1–4 changed.

## 1. Method and scope

Four independent area audits — agent core + run loop, model handler +
`packages/llm`, logger, and the `@texra-ai/agent` package surface + subagent
boundaries — each re-derived the banned-pattern candidates (pass-through
wrappers, convenience barrels, one-impl interfaces, single-caller extractions,
re-export shims, silent degradation) and re-counted **production (non-test)
callers** for the carried-forward `create*`/factory and exported-symbol
findings, per the AGENTS.md factory bar (a factory earns its place only with
multiple callers, real logic, class construction, or captured context).

Silent-degradation spot check: `grep` for empty `catch {}` blocks across
`src/agent`, `src/model`, `src/logger`, `packages/llm`, and `packages/agent`
(test-excluded) returns **zero** hits — an exhaustive result for that pattern.
The companion claim, that no `??` in the four areas covers a failed read, is a
**spot check** of the sites the area audits opened, not an exhaustive sweep of
every `??` in those trees; prior passes reached the same reading on the same
basis.

The per-commit diffstat trend-line accounting is not reproduced here (this
session inspected the end-state tree, sufficient for the standing question — is
there unnecessary abstraction _now_).

## 2. Tracked structural facts — re-verified at `3d5fbda`

| Item                                             | `-09-14` state                         | This pass (`3d5fbda`)                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node flow engine**                             | deleted                                | **still deleted.** `ls src/agent/node` → no such directory. Runs are the run-ledger Effect program (`src/shared/session/runLedger.ts`, 140 LoC).                      |
| **`ModelHandler.ts` god-base / `IModelHandler`** | deleted, no shim                       | **still gone.** `grep "class ModelHandler\|IModelHandler" src/ packages/` → zero production hits. Model stack is `ModelInvoker.ts` (**1,326** LoC) + `runtime/run/*`. |
| **`redactSecrets`**                              | single-arg, clean                      | **still clean.** `redactSecrets(text: string): string` (`src/logger/redaction.ts:58` after §5.2; `:93` before), straight-line body.                                   |
| **SDK version**                                  | 0.41.0                                 | **0.41.0** (`packages/agent/package.json`).                                                                                                                           |
| **README `effect` peer pin**                     | fixed to `4.0.0-rc.115` in `-09-14` PR | **holds.** `package.json` peer `4.0.0-rc.115`; README install guidance matches. No re-drift.                                                                          |
| **`createRunScope`** survivor                    | 1 production caller                    | **removed this PR.** Was 1 production caller (`AgentLaunchContext.ts:555`) + 5 test-kernel sites; the freeze is now inline at that call site (§5.1).                  |
| **`turnText` duplication** (`-09-14` §5.2)       | dup present, cleanup prescribed        | **resolved.** Relocated to leaf `run/turnText.ts:4`; four importers, no dup, no shim (§0).                                                                            |
| **Deep-import width** (cli/desktop/ext/agent)    | 5 / 4 / 8 / 7                          | **5 / 4 / 7 / 7** — extension shrank 8→7; rest hold.                                                                                                                  |
| **Tier-1 named doors**                           | 8/8 fronted                            | **8/8 fronted** — `src/agent/{export,followUp,index,review,runtime,storage,templates,trace}/index.ts` all present.                                                    |

## 3. Loop ↔ ledger boundary — fold-based continuation (unchanged)

The verified property is the **continuation model**, unchanged from `-09-14`:
the two run programs (`runtime/loop/toolUse.ts`, `runtime/loop/reflection.ts`)
call `ledger.appendBatch(runId, state, [...])` and continue from what
`appendBatch` returns (`foldRunState` over committed rows), so live and resume
are the same function — no cursor, no graph, no intermediate flow engine. The
ledger implementation is `RunLedger.appendBatch` (`src/agent/runtime/RunLedger.ts`,
460 LoC — distinct from the 140-LoC session contract
`src/shared/session/runLedger.ts`; capitalization disambiguates). As `-09-14`
established, **this pass makes no single-writer claim** — the write side is
deliberately multi-owner. What is re-verified: the fold-based continuation, the
CLAUDE.md "one publisher, loop-owned cards" rule holding on the loop's own path,
and **no silent degradation** in any of the four areas (§1).

## 4. Subagent boundaries — shipped 4-implementor SPI; one boundary correctly open

`ChildRunStrategy<TTurn, R>` (`src/agent/runtime/childRunLoop.ts:158`) +
`ChildRunPorts` (`:102`), driven by the single owner `startChildRunLoop` (`:889`),
remain a shipped, multi-implementor SPI, not a design task. Four distinct
production construction sites, unchanged:

| Site                                                 | Constructor                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `src/tools/delegation/nativeSubagentStrategy.ts:193` | `createNativeSubagentStrategy` (native subagent)                    |
| `src/tools/delegation/workflowScriptStrategy.ts:156` | `createWorkflowScriptStrategy` (workflow-script child)              |
| `src/tools/bash.ts:230`                              | `createBackgroundBashStrategy` (background shell; used `:558`)      |
| `src/tools/agentCliShared.ts:615`                    | inline `const strategy: ChildRunStrategy<TTurn>` (codex/claude CLI) |

**`runAgentCreator` remains the one genuine "logical agent not yet running as
one."** A single linear `Effect.fn` generator
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts:482`), one
production caller running **inline in the extension host**
(`packages/extension/src/commands/agent/agentCreatorCommands.ts:305`; moved from
`:188` at `-09-14` by intervening edits, still a single inline caller). It stays
open **correctly**: closing it is interactive-UI design work (the
`AgentCreatorUI`/`HostInteractions` approval channel the public surface
deliberately lacks), not a mechanical move (manifest §7.3).

## 5. Findings and dispositions

All four were carried-forward survivors; none was a defect. Three are closed
here at the maintainer's request, the fourth was already closed upstream.

1. **`createRunScope` — closed by inlining.** One production caller
   (`AgentLaunchContext.ts:555`) and a body of `Object.freeze({ ...scope })`
   under an identity `RunScope → RunScope` signature: a single-caller extraction,
   which the factory bar bans. Every prior pass offered the same two dispositions
   — "inline it or re-document the invariant" — and this PR takes the first,
   which also discharges the second: the function is deleted and the freeze now
   sits at the run's one real construction site, where a comment states the
   invariant it enforces (a run's identity and owning session must not change
   under the loop that reads them; `readonly` alone stops only callers that kept
   their types). `RunScope.ts` is now the interface alone. The five test-kernel
   sites build plain typed literals — a fixture does not need runtime
   enforcement of a production launch invariant — so the removal cost no test
   coverage. Verified: `grep createRunScope src/ packages/` → zero.
2. **`PROVIDER_KEY_REDACTION_RULES` — closed, and wider than the prescription.**
   The prescribed cleanup was "drop the `export`, move the fixture into the
   test." Doing so collapsed more than expected: the `examples` field was the
   only reason the `ProviderKeyRedactionRule` interface existed, and the only
   thing distinguishing most entries — production reads `rule.patterns` alone
   (pre-change `redaction.ts:75`). With the fixture gone the table is `Record<ApiKeyProviderId,
readonly RegExp[]>`, the interface is deleted, and the nine entries that
   differed only by their examples collapse onto one shared
   `OPENAI_COMPATIBLE_PATTERNS`. The compile-time exhaustiveness that earned the
   table its place is preserved verbatim (`satisfies Record<ApiKeyProviderId,
…>`), and is now documented as the point of the table: a new provider cannot
   ship with its keys unredacted. The examples move to
   `DesktopLogRedaction.vitest.ts` under their own `satisfies`, so the fixture
   stays exhaustive too, and that suite's coverage test now guards the fixture
   rather than restating a compile-time guarantee. The knip baseline entry is
   **removed, not rewritten** (`config/ratchets/knip-baseline.json`) — the
   ratchet shrinks; `check:dead-code-ratchet` passes at 180 vs 180.
3. **Tier-1 manifest re-enumeration — already closed upstream; this finding was
   wrong.** See the correction note at the head of this record. #12634
   (`0ffbe01`) re-enumerated the manifest on 2026-09-15. Nothing to do.
4. **`src/agent/runtime/README.md` drift — closed, and one ghost more than was
   flagged.** `-09-14` §5.6 flagged the `RunStatusService` entry and the "flat
   list of ~50 files" claim. Re-deriving rather than transcribing found a second
   ghost in the same file: the intro described `core` as "split into
   `definition/state/usage/tools/flows/`", but `core` has had three modules
   (`definition/`, `state/`, `tools/`) since `usage` became schemas and `flows`
   went with the node engine. A mechanical check of every module the README
   names (each backticked identifier resolved against the tree) found exactly
   those two ghosts and no others. Both are removed; the layout claim now states
   what is true — ~50 files at the top level **plus** the `run/` and `loop/`
   subdirectories — and the "Why this stays flat" section becomes "Why most of
   this stays flat", recording that its own standing exception ("if a future
   refactor touches a whole group's internal call sites anyway, revisit turning
   that group into a real subdirectory") is precisely what the Effect-4 cutover
   triggered to produce those two directories. The section's bar for any further
   subdirectory is unchanged.

## 6. Carried-forward design notes (unchanged, none a defect)

- **Logger + telemetry are process-global singletons** (`logSink.ts`'s
  module-level `let sink`, mutated by `setLogSink`). The SDK-correct unlock — an
  injectable sink owner behind a Tier-1 door — is designed for logging,
  unspecified for usage/telemetry.
- **Two Tier-1 leaf surfaces stay un-fronted, as the manifest predicts:**
  `@agent/core/state/runRequests` and
  `@agent/implementations/agentCreator/agentCreatorFlow` are still reached by
  full deep path; the latter is design-gated on `runAgentCreator`'s
  interactive-UI boundary (§4). For the SDK package's own row, `core/definition`
  and `core/tools` stay un-`index`ed — the deliberate width a Tier-1 barrel must
  re-export or seal.
- **`HostInteractions` required/optional** remains an open maintainer contract
  decision; **publication** remains gated on the named-external-consumer hold.

## 7. Bottom line

Thirteen consecutive passes find a green top-line verdict. This pass's
substantive content is **two convergent improvements, not news**: the `-09-14`
§5.2 `turnText` duplication was resolved exactly as prescribed (relocated to the
`run/turnText.ts` leaf module, four importers, no shim), and the extension's
deep-import width shrank 8 → 7 — both the shape of progress the standing open
work names, landed by ordinary cleanup PRs rather than by this routine. All
eight named doors stay fronted; the model stack is the cohesive `ModelInvoker.ts`

- `runtime/run/*` over the run ledger, with no `ModelHandler`/`IModelHandler`
  residue; the run loop's fold-based continuation and the logger re-verify clean
  with no silent degradation. The subagent SPI is a real four-implementor
  contract; `agentCreator` is the single, correctly-open boundary.

On the four §5 items: none was a defect, and on the maintainer's request three
are closed here — `createRunScope` inlined to its one construction site,
`PROVIDER_KEY_REDACTION_RULES` reduced to a non-exported pattern table with its
fixture moved into the suite that reads it (the knip baseline shrinking by one
entry rather than being rewritten), and the `runtime/README.md` ghosts removed.
The fourth was already closed upstream by #12634, and the first draft of this
record was wrong to carry it forward unverified. None of the three touches the
run loop, the model stack, the public surface, or any baseline in the widening
direction; each removes a carried-forward survivor the passes have tracked for
weeks. The standing open work is unchanged: **shrinking the frozen deep-import
lists** (extension 8 → 7 this interval) and the Tier-1 ratification — the
manifest's enumeration half is now done, its "what Tier-1 keeps or seals"
half is not.
