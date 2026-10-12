# Agent SDK readiness re-verify: the 2026-10-11 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-10-04 pass (`2026-10-04-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.

Pin: verified against branch `claude/eager-noether-zpwosl` at `ff8097d`. The
2026-10-04 pass's pin, `ae953c3` (branch `claude/eager-noether-hiwxl7`), is a
reachable ancestor of this HEAD in full history (~200 commits back) but is
**absent from this shallow working clone** (`git cat-file -t ae953c3` fails
until the clone is deepened — the same shallow-clone caveat the prior pass
recorded for its own pin). Rather than deepen, this pass re-verifies the live
tree directly and reads the delta from the recent `git log` and `CHANGELOG.md`
instead of a `rev-list` range. Four fresh
read-only audits — one each over the agent core, the model handler, the logger,
and the SDK public surface — were run at this pin; their verdicts match the
2026-10-04 pass.

## The program moved: the harness rename landed

The 2026-10-04 pass closed with "re-running this audit as a routine will again
add no signal until the harness program moves." It has moved. Since that pin,
the accepted durable-harness program (`2026-10-02-durable-harness.md`, status:
**accepted**) advanced on the one axis this audit tracks:

- **The package rename landed.** `@texra-ai/agent` / `packages/agent` is gone;
  the SDK surface now lives in `@texra-ai/harness` / `packages/harness`
  (`packages/agent` no longer exists on disk; `packages/harness/package.json`
  `name` is `@texra-ai/harness`). This resolves the **harness-name portion of
  durable-harness Q5** (the package name was explicitly open at the 2026-10-04
  pin, which is why that pass still wrote `packages/agent`); Q5 also covers
  retaining `@texra-ai/llm`, moving the app plugins to `packages/theorist`, and
  host locations, and `packages/theorist` does not exist at this pin, so the
  rest of Q5 stays open. The audited source dirs moved with it:
  `packages/harness/src/{agent,logger,model}/`.
- **The deep-import frozen list was renamed and shrank.**
  `config/ratchets/host-agent-import-baseline.json` →
  `config/ratchets/harness-deep-import-baseline.json`, now **187 distinct
  specifiers / 360 per-package rows** (the file's own semantics note records
  254 distinct at the SQ2 ruling and 256/501 at M8's end — so it has continued
  to narrow, never widen). Enforced by
  `src/test-kernel/architecture/harnessDeepImportRatchet.vitest.ts`.
- **Durable-harness lanes landed.** The run-history lanes on the harness
  package — D1 "every run write through its cell; runs born with their opening"
  (#13932) and D2a "every row a run's state folds commits through its cell"
  (#13938), plus the settlement/delivery single-append and
  plugin-aggregate-in-tool.result-batch consolidations (#13921, #13928) —
  sharpen the "one publisher, loop-owned cards, one history writer" contract
  without adding an indirection tier. G2 (#13940) is a **cross-package
  ownership move**, not harness-only: it relocates app-owned session and plugin
  modules into `packages/texra` with consumer updates across the CLI, desktop,
  extension, and trace-viewer.

So this pass records real movement, all of it through the human-owned
durable-harness program and ordinary review, none through this routine.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. **No autonomous refactor is warranted from this charter.** Every safe
candidate in these areas is already filed, already landed, or already recorded
as refused with a ruling (`config/ratchets/refuted-candidates.json`, still the
authoritative refused set — 9 candidates: 5 `EFF-ADOPT-*`, 3 `RT-*`, 1
`SCOPE-*`; no retained refusal was reversed. One, `EFF-ADOPT-config-provider`,
does pin a public-surface symbol — the `ConfigProvider` interface exported from
`index.ts` and recorded in `config/api-reports/harness.api.md` — so it must be
weighed when that port is revised; but the refusal stands and does not change
the no-abstraction verdict here). The four fresh audits found
**no wrapper layer that only forwards, no second run-history writer, no
services-bag, no re-export shim, no per-provider handler class.**

Concretely, each apparent "collapsible" abstraction is protected by a named
guardrail, which is why it stays:

- **Agent core** (`packages/harness/src/agent/`, ~29k LOC, bulk in `runtime/`).
  The barrels (`runtime/index.ts`, `followUp/`, `trace/`, `storage/`,
  `index/`) are the documented host-boundary doors recorded in
  `harness-deep-import-baseline.json`; deleting one would *widen* that baseline.
  The run-loop `Context.Service` classes (`Runs`, `ModelInvoker`, `ModelAccess`,
  `AgentRun`, `ChildRuns`, `RunCall`, …) are the "services from context, no
  services bag" contract. `AgentEngine.ts` (23 LOC, one implementer) is a
  real import-cycle break for the three recursive entry points, not a
  one-impl interface padding. The ~75 two-file exports are ratchet-forced file
  splits (400-line/150-line core-quality ceilings), not single-caller
  extractions. `runAgent` vs `executeAgent` is the documented owns-the-runId
  split (12 `executeAgent` sites). `ModelRetryGate` is on the refuted list
  (`EFF-ADOPT-retry-gate-schedule`).
- **Model handler.** Provider calls flow only through the `@texra-ai/llm`
  `Model` bound by `modelAccess/binding.ts`; `ModelInvoker` is the run loop's
  caller of it, with the helper path (`helperModel.ts`, which builds its own
  `ModelAccess` and calls `callModel` → `run/modelCall.ts`) and compaction as
  deliberate direct exceptions, not a second handler. Wire dispatch is one
  `switch (protocol)` over dynamic imports of
  data-only protocol arms + a compiler-exhaustive `CONFIGURE` table;
  providers are the `MODEL_PROVIDER_PLUGINS` data manifest. `grep "export
  class"` across `packages/llm/src` returns only error types
  (`Data.TaggedError`) plus generic OAuth/concurrency machinery
  (`SubscriptionOAuthCoordinator`, `SharedAttempt`, `SerializedWrites`) —
  **zero per-provider handler classes**. The codex/xai OAuth arms carry real
  provider-specific code (~500 lines each — device-login flow, JWT, client,
  constants) but share the one generic `SubscriptionOAuthCoordinator` through a
  small per-provider policy/session module, rather than a per-provider handler
  base.
  The few single-caller helpers (`helperRequest`, `subscriptionCredential`)
  carry real branching logic and keep the `bind` closure under the
  core-quality line ceiling.
- **Logger** (`packages/harness/src/logger/`, 5 files, 551 LOC). A clean
  single-owner producer→sink pipeline: `Effect.log*` + `withLogChannel`
  (386 `withLogChannel(` call sites) on the producer side; render→redact→truncate at one sink;
  `LogEntry` *is* Effect's structured record type, not a parallel type. The
  obvious wrapper candidates (`createLog`, `logUtils`, the CLI's former
  parallel `createCliLogger`/`LogRecord`) were already deleted (0 hits).
- **SDK surface** (`@texra-ai/harness`: `index.ts`, `node.ts`, `plugins.ts`,
  `schemas.ts`). The center — `Sessions`/`Session`/`Run` + tagged errors +
  `defineTool`, pure Effect — is minimal: no top-level Promise/AsyncIterable
  rendering and no `Effect.run*` outside the carved runtime entries (the one
  internal `runFork` is `processRuntime`'s fork-failure reporter, re-exported as
  `withForkFailureReporting`). `index.ts:81-88` deliberately sources
  `RunEndResult` off its own
  module (not the `@agent/runtime` barrel) so the published `.d.ts` graph never
  reaches a provider SDK — the leak check in
  `packages/harness/scripts/validate-artifacts.mjs` enforces exactly that.

## The four asks, re-mapped to the current pin

1. **Identify the areas** — re-confirmed at the new paths:
   - Agent core: `packages/harness/src/agent/core/` (`definition/`, `state/`,
     `tools/`); the one run program `@agent/runtime/loop/toolUse.ts` over the
     run history (a document task runs that one program over the documents
     plugin's recipe in `packages/texra`, not a harness round file); the model call at
     `@agent/runtime/ModelInvoker.ts` (with `run/compaction.ts` and the helper
     path invoking the bound `Model` directly — deliberate exceptions, not a
     second handler).
   - Model handler: `packages/llm` (`@texra-ai/llm`) reached only through the
     `Model` bound by `runtime/modelAccess/` (`ModelAccess.ts`, `binding.ts`,
     `routeDecision.ts`, `credentials.ts`).
     Deliberate exceptions outside the route are unchanged (audio transcription
     builds `OpenAI` directly; the `codex`/`claude_code` tools load their own
     provider SDKs; the settings-view consent probe acquires a VS Code `Model`).
   - Logger: `packages/harness/src/logger/` (`effectLog.ts`, `logSink.ts`,
     `effectDiagnostics.ts`, `formatLogData.ts`, `redaction.ts`).
   - SDK surface: `packages/harness` (`@texra-ai/harness`) — four package
     entries (`.`, `./schemas`, `./plugins`, `./node`); `effect/` is internal
     implementation behind the root entry, not a published subpath.
2. **Audit for unnecessary abstraction** — done, four ways (see Verdict). No
   net-negative candidate beyond the one cosmetic single-caller split carried
   below.
3. **Plan API-surface simplification** — the plan is the durable-harness
   program's *extend* half (`2026-10-02-durable-harness.md` H4: `Plugin`,
   `Sessions.layer({ plugins })`, `Plugins.contribute` in a `Scope`,
   `Session.resume`) plus the frozen-list shrink AGENTS.md names — **not**
   ratification of the 2026-09-10 static-export manifest (see New.1). The SDK
   speaks pure Effect end-to-end; the Promise boundary is deliberately gone.
4. **Design subagent boundaries** — first-class and unchanged. Three real
   boundaries: (a) native subagents via `executeAgent` with an owned `RunId`;
   (b) the workflow-script run plus its `agent()` grandchildren; (c) the
   agent-CLI children (`claude_code`, `codex`) via `startDetachedChildRunLoop`
   with provider-specific `ChildRunStrategy`. The non-candidates (round-output
   extraction, `compileCheck`, `LatexDiffManager`) have no independent run or
   model lifecycle, so reifying one buys nothing. No boundary change warranted.

## New since the 2026-10-04 pass (needs an owner, not a routine)

1. **The 2026-09-10 Tier-1 manifest — rewritten in this PR; ratification stays
   owner-level.** At commit `c139d88` it still named the deleted `@texra-ai/agent`
   / `packages/agent`, listed **3 entries** (missing `/plugins`), ~67 bindings,
   and included removed names (`ToolHost`, `PlatformConflict`, the workflow
   configs, `AgentCategory`) against a live root entry of **35 `export`
   statements / ~90 bindings**. This PR rewrites it: the rename and moved paths
   are fixed, and the drift-prone hand-enumeration (four hand re-counts since
   `cf88d2d`) is replaced by a pointer to the committed, auto-regenerated
   `config/api-reports/harness*.api.md`. What stays owner-level is the
   **ratification** — re-scope around the durable-harness extend surface
   (`Plugin`, `Composition`, `Sessions.layer`, `Plugins.contribute`,
   `Session.resume`) and decide keep/seal/shed for the surviving open questions;
   it is not a routine edit.
2. **The logger sink→Layer step is still unlanded.** `logSink.ts` (~165–186)
   still holds the mutable module global (`let sink = consoleLogSink`,
   `setLogSink`, `writeLogEntry`), set by host callers. This is the one real
   SDK-relevant host leak: an embedder of `@texra-ai/harness` gets whatever
   process-global sink is set and cannot inject its own through
   `Sessions.layer` / `AgentPlatform`; two embedders in one process share one
   global. It is step 6 of `2026-09-21-effect-design-synchronous-facades.md` §5
   (steps 1–5 landed), the expensive step (it rewrites the kernel log-capture
   seam used by ~12 suites via `src/test-kernel/support/logSinkCapture.ts`), and
   it does not by itself deliver embedder injection through the public boundary
   — a further, not-yet-designed public-API step. Owner-gated; no autonomous
   refactor.
3. **Two `packages/llm` ambient `process.env.*_CUSTOM_HEADERS` reads need
   filing** — `anthropicMessages.ts:715` and `openaiResponsesRequest.ts:254`
   (the third went with `openaiChat.ts` in the earlier chat-codec
   consolidation). Moving the check to the host boundary is a relocation that
   must be passed explicitly into every factory (the `packages/llm/test-live/`
   callers construct the factories without `modelBinding`), not a lift. Low
   priority; file into `2026-09-20-llm-package-hardening.md` or a fresh
   tech-debt entry.
4. **Doc drift from the baseline rename.** Several historical proposal and
   implemented notes still say `host-agent-import-baseline.json`; the live
   ratchet file (`config/ratchets/harness-deep-import-baseline.json`) and its
   kernel test (`harnessDeepImportRatchet.vitest.ts`) already use the new name,
   so this is doc-only. Pure doc fixes; fold into whichever owner touches those
   notes next.

## Shrinking the deep-import baseline (the non-widening narrowing path)

Consistent with "never widen a baseline," the way to *shrink*
`harness-deep-import-baseline.json` is to promote the heaviest, most-shared
deep imports into a documented public re-export on `@texra-ai/harness` (with
the existing consumer), then delete the now-stale rows. The natural Tier-1
promotion set, by host-fan-out: `@shared/schemas` and
`@utils/errors/errorMessage` (both imported by all 5 packages), then the
4-package cluster (`@agent/index`, `@agent/runtime`, `@eventBus/AppSignals`,
`@logger/effectLog`, `@logger/logSink`, `@platform/rootedFs`,
`@shared/session/database`, `@shared/session/sessionView`, `@utils/core`, …).
Each promotion is strictly a narrowing under the ratchet's set semantics. This
is owner work paired with New.1 (the manifest re-scope decides what becomes
public); it is not a routine edit.

## Marginal cleanups (tech-debt-tier)

- The prior pass's `finalizeRunTerminalBody` single-caller item is **resolved**:
  no such symbol exists at this pin; `finalizeRunTerminal`
  (`AgentRunLifecycle.ts:113`) is already `Effect.uninterruptible`-wrapped and
  has two executable call sites (`AgentRunLifecycle.ts:276`,
  `tools/delegation/childRun.ts:147`). Dropped.
- `redaction.ts` `redactDisplayValue` docblock wording is slightly stale (claims
  "other callers hand it raw values"; its only production caller is
  `logSink.redactEntry`, though the raw-`Error` branch stays reachable). Not
  worth a change.

**Do not collapse**: the `Effect.scoped` / `acquireRelease` regions in
`executeAgent.ts` (`executeAgent` and `resumeToolUseFromResumeData`) — their
nesting order is load-bearing for finalizer-before-release ordering. (The prior
pass's "three-level `resumeToolUse*` chain" phrasing is stale: there is one
resume entry, `resumeToolUseFromResumeData`.) The `modelAccess/binding.ts`
re-guard disjuncts are reachable format/route-mismatch cases (trimming would be
a silent-degradation regression; refuted in the prior pass).

## Recommendation

No refactor to land autonomously from this charter. The charter tracks the
accepted durable-harness program (H1–H5). This PR rewrites the stale Tier-1
manifest (New.1); the owner-level action that remains is to **ratify it** —
re-scope around the harness extend surface and settle keep/seal/shed. The logger
sink→Layer step
(New.2) rides `2026-09-21-effect-design-synchronous-facades.md`; the two
`packages/llm` ambient reads (New.3) and the filename drift (New.4) need filing.
With the rename landed, the next signal this routine can add will come when the
manifest is re-scoped or the next durable-harness lane changes one of the four
areas; until then, re-running the audit will again confirm alignment without
finding a gap.
