# Agent SDK readiness re-verify: the 2026-09-25 pass

Status: proposed

Origin: the standing scheduled "review and refactor for Agent SDK readiness"
charter. This note re-pins the standing finding to a newer tree state; it does
not re-derive the analysis. The full map, ownership statements and reasoning
live in the [2026-09-24 re-verification](./2026-09-24-agent-sdk-readiness-reverify.md)
and are unchanged. Read that note first — this one only records the delta.

## Verdict

Still well-aligned. Nothing in this charter is a landable autonomous refactor:
every safe candidate in the agent core / model handler / logger / SDK-surface
areas is already filed, landed, or recorded as refused with a ruling
(`config/ratchets/refuted-candidates.json`, 179 lines, intact). The remaining
work is human-owned (manifest ratification, frozen-list shrink, one owner
ruling). Acting here would re-mine a refused candidate or duplicate a filed
issue.

## What moved since the 2026-09-24 pin

The prior note verified `origin/main` at `7326fb4`. This pass re-checked the
work branch tip `6d93531` (10 commits of ordinary feature/fix work ahead of that
pin; the two lines have diverged in-flight, which is normal). Structural
re-checks at `6d93531`:

- **SDK boundary still pure Effect.** `packages/agent/src/index.ts` calls no
  `runPromise`/`runSync`/`runFork` (the only mentions are the doc comment stating
  the *embedder* owns that call); `effect` stays an exact-pin peer dep
  (`4.0.0-rc.117`).
- **Agent core / run loop / model handler unchanged.** `src/agent/core/README.md`,
  `runtime/loop/{toolUse,reflection}.ts`, and `runtime/ModelInvoker.ts` all
  present; chat/model-turn calls still route only through the `packages/llm`
  `Model` bound in `runtime/run/modelBinding.ts`.
- **Subagent boundary intact.** Dispatch still mints its own `runId`
  (`generateRunId()` in `runtime/runAgent.ts`); bundled agents remain YAML under
  `packages/extension/resources/agents/` and `.../tool_use_agents/`.
- **`createLog` retirement advanced, not stalled.** Refs across `src/**` and
  `packages/*/src/**` fell from 68 (at `7326fb4`) to 53 (at `6d93531`) — the
  in-flight retirement (#12886) is making progress toward the redacting log sink
  as the one owner (#13056).

## Open items — unchanged, still human-owned

- **Tier-1 public manifest** — still `proposed`
  (`2026-09-10-agent-sdk-tier-1-manifest.md`). No consumer wiring landed; the
  frozen-list shrink still waits on it.
- **The two agent-creation systems** (survey §2) — both still present
  (`texra.createAgentWithAI` wizard wiring in
  `packages/extension/src/settingsView/handlers/agentHandlers.ts` and the
  `creator` tool-use agent at
  `packages/extension/resources/tool_use_agents/creator.yaml`). Collapsing them
  reverses two rulings and changes user-visible behaviour, so it needs an owner,
  not a routine.

## Recommendation

No refactor to land autonomously. The 2026-09-24 recommendation still holds:
re-running this audit adds no new signal until the Tier-1 manifest moves. The
only fresh signal this pass carries is confirmation that a week of feature/fix
work introduced no SDK-readiness regression and that `createLog` retirement is
progressing.
