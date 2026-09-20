# Agent-SDK readiness — re-verification pass (2026-09-20)

Status: implemented

> **Written 2026-09-20.** The scheduled audit routine re-ran the standing
> question — "review the agent core, model handler, logger, and surface for
> unnecessary abstraction and unready surface; design subagent boundaries" —
> against the immediately prior filed pass
> ([`-09-17`](./2026-09-17-agent-sdk-readiness-reverify.md), the "thirteenth
> consecutive green", inspected at `3d5fbda`) and the Tier-1 manifest of record
> ([`2026-09-10-agent-sdk-tier-1-manifest.md`](../../proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md)).
> This is the **fourteenth consecutive green pass** (`-08-19` through `-09-20`).
> No `-09-18` or `-09-19` reverify record exists under
> [`implemented/simplification/`](./) — the routine did not file on those days
> (the `-09-19` note there is `retire-pandoc-scratchpad-tier`, a different
> topic) — so `-09-17` is the immediately prior pass and the lineage has no gap
> in substance. Facts below are re-derived by direct inspection at `e653430`,
> the working tip when this pass ran (`origin/main` in this clone is the stale
> `3d5fbda`; `e653430` is 50 commits past it). Each carries a `file:line`,
> config path, or count.

> **Disposition.** This is a scheduled firing and carries **no maintainer
> request**, so it runs under the routine's standing default: **recorded, not
> acted on.** None of the four §5 candidates is a defect; each is a
> carried-forward-shaped, low-confidence tidy-up left for a maintainer to
> take (or to ride an adjacent PR) rather than a speculative edit this pass
> makes. Nothing in the four audited areas was changed by this pass.

## 0. Verdict

**The standing structural verdict holds: the codebase is well-aligned with an
Agent-SDK shape, and no speculative refactor is warranted.** Fourteen
consecutive passes (`-08-19` → `-09-20`) reach the same top-line conclusion.
Four independent area audits (agent core + run loop; model handler +
`packages/llm`; logger; the `@texra-ai/agent` package surface + subagent
boundaries) re-derived the banned-pattern candidates and re-counted
**production (non-test) callers**; none surfaced a material factory /
pass-through / one-implementor-interface / silent-degradation violation. The
`3d5fbda..e653430` interval (50 commits, **15** touching the four areas) is not
this routine's work and is **overwhelmingly net-negative cleanup** moving in
the direction the prior passes name — e.g. `#12867` "one credential source, one
provider module, one signed-in probe", `#12840`/`#12853` launching agent-CLI
children through the shared detached-child primitive, `#12848` "delete three
provably-inert branches in the run loops", `#12840` (dup) `#12864` shrinking the
knip baseline to 158. The structural conclusion is an **end-state** property,
resting on the §1 audits and the ratchets that would reject such an addition,
not on a per-commit review of all 50.

## 1. Method and scope

Four independent area audits, each re-deriving the banned-pattern candidates
(pass-through wrappers, convenience barrels, one-impl interfaces, single-caller
extractions, re-export shims, silent degradation) and re-counting production
(non-test) callers, per the AGENTS.md factory bar (a factory earns its place
only with multiple callers, real logic, class construction, or captured
context).

Silent-degradation spot check: `grep` for empty `catch {}` blocks across
`src/agent`, `src/model`, `src/logger`, `packages/llm`, and `packages/agent`
(test-excluded) returns **zero** hits — an exhaustive result for that pattern.
The companion `??`-over-failed-read claim is, as in prior passes, a spot check
of the sites the area audits opened, not an exhaustive sweep.

## 2. Tracked structural facts — re-verified at `e653430`

| Item                                             | `-09-17` state                       | This pass (`e653430`)                                                                                                                        |
| ------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node flow engine**                             | deleted                              | **still deleted.** `ls src/agent/node` → no such directory.                                                                                   |
| **`ModelHandler.ts` god-base / `IModelHandler`** | deleted, no shim                     | **still gone.** `grep "class ModelHandler\|IModelHandler" src/ packages/` → zero production hits.                                             |
| **`createRunScope`** (closed `-09-17` §5.1)      | inlined, removed                     | **stays closed.** `grep createRunScope src/ packages/` → zero.                                                                               |
| **`PROVIDER_KEY_REDACTION_RULES`** (closed §5.2) | de-exported, table reduced           | **stays closed.** `grep "export const PROVIDER_KEY_REDACTION_RULES\|export.*ProviderKeyRedactionRule" src/` → zero.                          |
| **SDK version**                                  | 0.41.0                               | **0.41.0** (`packages/agent/package.json`).                                                                                                   |
| **Deep-import width** (cli/desktop/ext/agent)    | 5 / 4 / 7 / 7                        | **5 / 4 / 7 / 7** — unchanged this interval (`config/ratchets/host-agent-import-baseline.json`). No baseline widened.                        |
| **Tier-1 named doors**                           | 8/8 fronted                          | **8/8 fronted** — `src/agent/{export,followUp,index,review,runtime,storage,templates,trace}/index.ts` all present.                            |

## 3. Loop ↔ ledger boundary — fold-based continuation (unchanged)

The verified property is the **continuation model**: the two run programs
(`runtime/loop/toolUse.ts`, `runtime/loop/reflection.ts`) call
`ledger.appendBatch(runId, state, [...])` and continue from what `appendBatch`
returns (`foldRunState` over committed rows), so live and resume are the same
function — no cursor, no graph, no intermediate flow engine. As prior passes
established, this pass makes **no single-writer claim** — the write side is
deliberately multi-owner. Re-verified: the fold-based continuation, the
CLAUDE.md "one publisher, loop-owned cards" rule on the loop's own path, and no
silent degradation in the four areas (§1). `#12848` ("delete three
provably-inert branches in the run loops") and `#12854` ("one resume identity,
one classification, one snapshot read") landed in-interval and move this
boundary toward fewer branches, not more.

## 4. Subagent boundaries — shipped 4-implementor SPI; one boundary correctly open

`ChildRunStrategy<TTurn, R>` (`src/agent/runtime/childRunLoop.ts`), driven by
the single owner `startChildRunLoop`, remains a shipped, multi-implementor SPI,
not a design task. Four distinct production construction sites, unchanged:

| Site                                                 | Constructor                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `src/tools/delegation/nativeSubagentStrategy.ts:185` | `createNativeSubagentStrategy` (native subagent)               |
| `src/tools/delegation/workflowScriptStrategy.ts:156` | `createWorkflowScriptStrategy` (workflow-script child)         |
| `src/tools/bash.ts:230`                              | `createBackgroundBashStrategy` (background shell)              |
| `src/tools/agentCliShared.ts:602`                    | inline `const strategy: ChildRunStrategy<TTurn>` (codex/claude CLI) |

`#12840`/`#12853` routed the agent-CLI children through the shared
detached-child primitive in-interval, tightening — not multiplying — this seam.

**`runAgentCreator` remains the one genuine "logical agent not yet running as
one."** A single linear generator
(`src/agent/implementations/agentCreator/agentCreatorFlow.ts`) with one
production caller running inline in the extension host. It stays open
**correctly**: closing it is interactive-UI design work (the
`AgentCreatorUI` / `HostInteractions` approval channel the public surface
deliberately lacks), not a mechanical move (manifest §7.3). The `@texra-ai/agent`
package still attaches a fixed headless host and refuses approval-requiring
tools, which keeps this boundary open by construction.

## 5. Findings and dispositions — recorded, not acted on

Four low-confidence candidates surfaced this pass; **none is a defect**, and
under the standing default (§ Disposition) each is recorded for a maintainer to
take or leave, not edited here. Two are new to this pass; the model-layer pair
survived the in-interval `#12867` "one signed-in probe" consolidation.

1. **`generateExportFilename` re-export shim — LOW.**
   `src/agent/export/chatExportFormatter.ts:27` re-exports
   `generateExportFilename` from `./chatExport/filenames` (defined at
   `chatExport/filenames.ts:20`); `chatExportFormatter` does not itself consume
   it. The sole importer of the re-export is
   `src/controllers/progressView/ChatExportController.ts` (imports it alongside
   `formatChatAsMarkdown`/`formatChatAsLatex`). This is the one cross-file
   `export … from` outside an index in the whole `src/agent` tree, so it reads
   against the CLAUDE.md "no convenience barrels / import the defining file"
   line. Removal (repoint the one controller import, delete the line) is
   behavior-preserving. LOW because `chatExportFormatter` is plausibly the
   intended small chat-export facade (format-md / format-tex / filename).

2. **`resolveCodexSubscriptionProfile` single-caller split — LOW.**
   `src/model/providerCapabilities.ts:91`, called once at `:131` (same file) by
   `resolveCodexSubscriptionCapabilities`, which adds only the
   `isPreferCodexSubscription` gate before delegating. Its xAI twin
   `resolveXaiSubscriptionCapabilities` (`:217`) does the identical prefer-gate +
   eligibility + profile shape in a single function with no private helper — so
   the Codex path carries a single-caller split the xAI path proves unnecessary.
   Inlining to match the twin is behavior-preserving.

3. **`buildUserVarPassthrough` single-caller extraction — LOW.**
   `src/agent/prompt/userVars.ts:66`, exported, one production caller
   (`src/agent/templates/agentTemplateRenderer.ts:19`, cached in a module-level
   `const PASSTHROUGH`). Reads against "single-caller extractions are banned",
   but it has real logic (map → `fromEntries` → freeze) and is colocated with
   its data source `USER_VAR_RUNTIME_TOKENS`; the factory rule permits a factory
   with real logic. (`#12866` "retire the never-read UserVars template names"
   touched this file in-interval without collapsing the helper.)

4. **`isXaiSubscriptionActive` symmetric wrapper + `openRouterEndpoint.ts`
   micro-module — LOW / cosmetic.** `providerCapabilities.ts:233`
   (`isXaiSubscriptionActive`) has one production caller
   (`setupCredentialAccess.ts:108`) and adds nothing over
   `signedInSubscriptionUsageRoute`; its twin `isCodexSubscriptionActive` has
   two, so this exists for symmetry. Separately, `src/model/openRouterEndpoint.ts`
   is a one-line constant module (`OPENROUTER_BASE_URL`, two importers:
   `glmRouting.ts`, `run/routeEndpoint.ts`) whose sibling `KIMI_CODE_BASE_URL`
   lives in `@shared/constants/providers` — a placement inconsistency, not
   indirection that hides logic. Both are cosmetic and would ride adjacent work.

The logger layer surfaced **no** candidate: logging is correctly kept out of
the platform interface and funneled through the single redacting sink
(`@logger/logSink`); the apparent "redundant" wrappers (`createLog` vs the free
`debug/info/warn/error`, `withLogChannel`, the `DebugModeConfig` port) each
carry a documented, load-bearing reason (test-spy seam, `LOG_CHANNEL` SSOT,
host decoupling).

## 6. Carried-forward design notes (unchanged, none a defect)

- **The two-producer logging split** — Promise-path `@logger/logUtils` (~150
  callers) and Effect-path `@logger/effectLog` + `effectDiagnostics` (~11
  callers) — remains a convergent, single-sink seam, documented as intentional
  and temporary (`logUtils.ts` header: deleted with its last non-Effect caller).
  A migration to *finish* as the Promise leaves convert, not an abstraction to
  cut. `#12811`/`#12823`/`#12824` closed further Promise faces in-interval.
- **Logger + telemetry are process-global singletons** (`logSink.ts` module-level
  `let sink`); the SDK-correct unlock is an injectable sink owner behind a
  Tier-1 door.
- **`HostInteractions` required/optional** remains an open maintainer contract
  decision; **publication** remains gated on the named-external-consumer hold
  (`CLAUDE.md`: "npm publication is deliberately held until a named external
  consumer exists").

## 7. Bottom line

Fourteen consecutive passes find a green top-line verdict. This pass has **no
substantive news**: every tracked structural fact re-verifies at `e653430`
(node engine gone, no `ModelHandler`/`IModelHandler`, `createRunScope` and
`PROVIDER_KEY_REDACTION_RULES` stay closed, deep-import width holds at
5/4/7/7, all eight named doors fronted, empty-`catch {}` sweep clean), and the
50-commit interval is ordinary net-negative cleanup moving in the named
direction. Four low-confidence tidy-ups are recorded (§5) and, per the standing
scheduled-firing default, **not acted on**; none touches the run loop, the
model stack, the public surface, or any baseline in the widening direction. The
standing open work is unchanged: **shrinking the frozen deep-import lists** (no
movement this interval) and the **Tier-1 ratification** — the manifest's
enumeration half is done, its "what Tier-1 keeps or seals" half (trim the
entirely-unconsumed `/schemas` entry; decide whether the `/effect`
storage-failure plane and `AgentPlatform`'s `Platform`/roots coupling belong on
Tier-1) is not.
