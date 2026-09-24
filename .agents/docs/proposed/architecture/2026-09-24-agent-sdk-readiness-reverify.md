# Agent SDK readiness re-verify: the 2026-09-24 pass

Status: proposed

Origin: a scheduled "review and refactor for Agent SDK readiness" charter —
identify the agent core, model handler, logger and surface areas; audit each
for unnecessary abstraction; plan API-surface simplification; design subagent
boundaries; document findings. This note is the finding.

## Verdict

The codebase is already well-aligned, and the audit this charter asks for is a
standing program, not a gap. The four asks map onto artifacts that already
exist and are current as of `main` at `7326fb4`. No autonomous refactor was
landed: every safe candidate in these areas is already filed as a tech-debt
issue, already landed, or already recorded as refused with a ruling. Acting
without a human here would either re-mine a refused candidate (the exact
failure `config/ratchets/refuted-candidates.json` exists to stop) or duplicate
a filed issue. The open work that remains is ratification and manifest-writing,
which needs an owner, not a routine.

## What each ask maps to

1. **Identify agent core / model handler / logger / surface areas.** Already
   mapped, with ownership stated:
   - Agent core: `src/agent/core/` (`definition/`, `state/`, `tools/`), doc'd in
     `src/agent/core/README.md`. Run programs are `@agent/runtime/loop/`
     (`toolUse.ts`, `reflection.ts`); the one model call is
     `@agent/runtime/ModelInvoker.ts`.
   - Model handler: provider APIs are reached only through the `packages/llm`
     `Model` bound by `runtime/run/modelBinding.ts`. As of `7326fb4` model
     providers are plugin contributions (#13094).
   - Logger: `src/logger/` (`effectLog.ts`, `logSink.ts`, `redaction.ts`, …);
     `createLog` retirement is mid-flight (#12886, commit `6560915`), tracked
     to the redacting log sink as the one owner (#13056).
   - SDK surface: `packages/agent` (`@texra-ai/agent`) — `index.ts`, `node.ts`,
     `schemas.ts`, `effect/`. Documented public barrel; the one place the
     "no convenience barrels" rule is waived.

2. **Audit for unnecessary abstraction.** Ran on 2026-09-23 as the
   whole-architecture SSOT pass
   (`.agents/docs/proposed/simplification/2026-09-23-ssot-ownership-survey.md`):
   eleven read-only mappers over exactly these seams (session ledger, model
   routing, tools/delegation, settings/config, platform/hosts, persistence, UI
   state, wire schemas, agents/resources, signals+logging, latex/controllers).
   Output: eleven bounded deletions and one candidate parked for an owner
   ruling. The eleven were filed as #13052–#13063 and have since **all landed
   and closed `completed`** via merged PR #13064 ("one owner per fact — eleven
   SSOT deletions … −1,732 lines"), so that backlog is cleared, not pending.
   Candidates already investigated and refused are pinned as data in
   `refuted-candidates.json` behind two CI gates.

3. **Plan API-surface simplification / align with SDK patterns.** The plan is
   the Tier-1 public manifest
   (`.agents/docs/proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md`,
   status `proposed`) plus the frozen-list shrink work AGENTS.md names as "the
   remaining boundary work." The SDK already speaks pure Effect end-to-end
   (`index.ts`: no `runPromise`/`runSync`/`runFork`; `effect` is an exact-pin
   peer dep), so the Anthropic-SDK-style Promise boundary is deliberately gone,
   not missing.

4. **Design subagent boundaries.** Already a first-class runtime concept, not a
   design gap: subagent dispatch and resume own their own `executionId` and go
   through `executeAgent` (not `runAgent`); bundled agents are YAML under
   `packages/extension/resources/agents/` and `.../tool_use_agents/`. The
   remaining boundary decision — collapsing the two AI-agent-creation systems
   (`texra.createAgentWithAI` wizard vs. the `creator` tool-use agent) to one
   owner — is written up in the 2026-09-23 survey §2 and needs an owner ruling
   because it changes user-visible behaviour and reverses two rulings.

## Genuinely open (needs an owner, not a routine)

- **Ratify the Tier-1 public manifest** — exact exports and actual consumers;
  everything else on `packages/agent`'s surface then seals or sheds. Blocks the
  `StreamTabId`/`ExecutionId` vocabulary collapse
  (`2026-09-10-collapse-duplicate-concepts.md`).
- **Shrink the frozen lists** (host-agent-import, effect-migration,
  store-public-surface) as the manifest ratifies each edge; never widen.
- **Owner ruling on the two agent-creation systems** (survey §2). Independent of
  the ruling, `tool_catalog.md` is drifting from the registry and should be
  reconciled.

## Verified cleanups already done since their proposals

- P5 "delete the SDK `Runtime` tag" (`2026-09-20-service-scope-ownership-ledger.md`):
  landed. No `Runtime` service class at `runtime.ts:264`, no `effect.ts` barrel
  exporting it, and it is `yield*`ed nowhere. The frozen set already shrank here.
- Model providers as plugin contributions (#13094) and CLI slash commands /
  MCP servers as plugins (#13092, #13093): landed at HEAD.
- The eleven SSOT deletions from the 2026-09-23 survey (#13052–#13063): landed
  and closed `completed` via merged PR #13064 (−1,732 lines) on 2026-09-23,
  before this note was written. `src/platform/platform.ts`,
  `src/agent/types/ServerTools.ts`, `src/tools/support/enumConfig.ts` and
  `src/latex/latexdiff/mathMarkup.ts` are all absent from the tree, confirming
  the deletions. Only the survey §2 candidate (two agent-creation systems)
  remains open, awaiting an owner ruling.

## Recommendation

No refactor to land autonomously from this charter. The 2026-09-23 survey's
eleven bounded deletions already merged (#13064). The remaining actions are
human-owned: pin the Tier-1 manifest, let the frozen-list shrink follow it, and
rule on the survey §2 candidate. Re-running this audit as a routine adds no
signal until the manifest moves — the map is current.
