---
created: 2026-09-24
status: proposed
---

# One run program: workflow agents as round mode of the tool-use loop

Baseline: `origin/main` at `13a1a96330`. Owner goal this serves: "everything
is a plugin" (the 2026-09-24 plugin architecture), with one core loop that
plugins extend instead of two loops that each re-implement the same run
mechanics.

## Summary

TeXRA has two run programs over one ledger:

|                            | File                                                         | Lines       |
| -------------------------- | ------------------------------------------------------------ | ----------- |
| Tool-use loop              | `src/agent/runtime/loop/toolUse.ts` (+ `toolUseDispatch.ts`) | 796 (+ 956) |
| Reflection loop            | `src/agent/runtime/loop/reflection.ts`                       | 1,165       |
| Reflection output pipeline | `src/agent/output/`                                          | 3,734       |

A workflow agent (polish, correct, paper2slide, …) is a fixed number of
rounds. Each round is one user turn, a model response that may be continued
if the output limit cut it off, and then output processing: XML extraction,
lineage, latexdiff, a compile check and a round summary. The rounds already
share one conversation, since `prepareRound` appends each round's prompt to
the same message history (`reflection.ts:516`).

That is the tool-use loop with no tools, plus two things:

1. **At idle, something decides the next turn.** The tool-use loop already has
   one such decider: goal mode (`maybeBuildGoalContinuation`,
   `toolUse.ts:676`). Rounds would be the second.
2. **After a turn, something processes the text.** This is the documents
   output pipeline, which becomes a plugin.

This proposal makes both of those seams explicit, moves the documents pipeline
behind the second one, runs workflow agents through the tool-use loop, and
then deletes `reflection.ts`.

A prototype (not merged) ran real `polish` and `correct` jobs on DeepSeek
through the CLI in both modes:

|                                               | Reflection   | Round mode   |
| --------------------------------------------- | ------------ | ------------ |
| Model calls (2-round polish)                  | 2            | 2            |
| Ledger rows                                   | 101          | 91           |
| Round-2 input tokens served from prompt cache | 896 of 1,463 | 896 of 1,460 |
| Request bytes                                 | —            | identical    |

It also resumed a run interrupted in round 2, re-issuing only the open request
and keeping round 1's output. And it continued a round that the output limit
cut off, within that same round.

## What gets deleted

- `src/agent/runtime/loop/reflection.ts` (1,165 lines). Its output half, about
  330 lines, moves into the documents plugin. Its loop half — opening,
  restore, round entry, response cycles, finish and settle — has no
  replacement, because the tool-use loop already does each of these.
- `launchReflectionRun` in `executeAgent.ts`, and the category branch that
  picks it.
- The `reflection` arm of `FlowSnapshotPayloadSchema`
  (`runLedgerEvent.ts:546`) and `ReflectionSnapshotStateSchema`.
- The `round.ready` and `output.pending` loop phases (`runLedgerEvent.ts:474`,
  `:478`). The pipeline's re-entry is derived from folded state instead (see
  "Resume").
- The per-cycle raw files (`raw/r<n>/output.c<i>.txt`) and the
  `readRawOutput` concatenation. The round's text is folded from the
  assistant messages, which are already rows.
- The `RESUME_BY_CATEGORY` family split in `SessionResumeRetrieval.ts:43`.
  Both categories resume the `toolUse` family.
- A second copy of the run mechanics: model invoke, usage recording, stage
  opening, `settleRun`, `stoppedBy`, cancellation and failure mapping.
  Today a bug in one of these can need fixing in both loops. Both
  continuation bugs found on 2026-09-24 were reflection-only: #13150 (stop
  sequences) and #13157 (`continuationIndex` reset).

Net estimate from the prototype: about −800 production lines. Nothing in the
output pipeline itself (`src/agent/output/`) is deleted. It moves behind the
plugin boundary unchanged.

## What stays

- **The workflow category.** Agent YAML keeps `category: workflow`, and the 45
  production files that branch on it keep doing so for UI and output opening.
  The category now selects the documents plugin and round count instead of a
  loop.
- **Round semantics:** the `rounds:` count, `userRequest` templates per round,
  compile-failure context injected into the next round, reject-on-compile-
  failure, latexdiff and the auto-opened PDF.
- **`output.produced` rows** (`sessionEvent.ts:351`). They remain the durable
  record of each round's outputs.
- **Workflow scripts** (`workflowScriptAgentRunner.ts`). A script child that is
  a workflow agent still runs as one child turn, and the retry and refusal
  rules there are unchanged.

## Design

### Seam 1: continuation at idle

The loop parks in `waiting` after a completed turn. Today it asks goal mode
whether to open a synthetic turn (`toolUse.ts:676-686`). This becomes one
typed seam:

```ts
interface ContinuationPolicy {
  /** At idle: the next synthetic turn, a finish, or nothing (park). */
  readonly atIdle: (
    state: RunState,
  ) => Effect.Effect<{ turn: string } | { finish: RunOutcome } | null, Error>;
}
```

It has two users:

- **Goal mode** is the existing code moved behind the seam. Goal state and its
  auto-approval stay in core (`@tools/goal`), and only the "open another turn?"
  decision moves.
- **Rounds** return `{ turn: nextRoundPrompt }` until `state.turn` reaches
  `totalRounds`, then `{ finish }`. The outcome is `failed` when the last round
  left an unresolved compile rejection.

This is an agent-runtime seam, not a manifest plugin hook: `src/tools/plugins.ts`
still says plugins are data. The run resolves the policy once from the agent's
category and setting, at the same place it resolves the toolset. It is not
threaded through a parameter object; the prototype's `start.rounds?` field is
not the shape to land.

A round-mode run takes no user input. A failed turn ends the run instead of
parking for a follow-up, as reflection does today.

### Seam 2: after-turn output handler

After a completed turn, the handler receives the turn's text and may append
rows through the run cell (`output.produced`). That keeps the loop the only
writer. The documents plugin is its one user:

```ts
interface TurnOutputHandler {
  readonly afterTurn: (round: number, text: string, cell: RunCell) =>
    Effect.Effect<void, Error, FileSystem | WorkspaceFs | ChildProcessSpawner>;
  readonly opening: Effect.Effect<{ system: string; content: InputPart[] }, Error, ...>;
  readonly nextRound: (round: number) => Effect.Effect<string, Error>;
}
```

The documents plugin is `src/agent/output/documentRounds.ts`. It holds what
`reflection.ts` does today in `prepareRound` (TeXCount, round prompt, input
media, compile-failure context), `processOutput`, `fallbackOutput`,
`presentOutput` and `produceOutput`. It lives next to the pipeline it drives.

### Length continuation and overflow recovery move into the loop

Today only reflection continues a response cut off by `length`, and only
reflection retries once after a forced compaction on `context-window-exceeded`
(`reflection.ts:601-698`). The tool-use loop does neither. Both move into a
sibling module of the tool-use loop, `loop/continuation.ts`, because
`toolUse.ts` is at its 797-line budget. From then on they apply to every
agent, and a chat agent cut off mid-answer continues too. That is a
behavior change for tool-use agents; see "Risks".

Two corrections to the prototype:

- **The continuation count is folded state (`continuationIndex`, per round
  since #13157), not a loop-local counter.** A resumed run must not get a
  fresh budget of 10.
- **A continuation turn is marked by a row field, not recognized by its prompt
  prefix.** The prototype's `roundTextOf` scans for `"Your response got cut
off"`, and a user could type that.

`overflowRecoveredAtRound` (`runStateFold.ts:192`) already exists in the fold
and carries over unchanged.

### State the plugin needs across resume

Reflection's family snapshot carries `totalRounds`, `compileFailureContext`,
`unresolvedCompileRejection` and a workspace snapshot. In round mode:

- **`totalRounds`** comes from configuration, as it already does on resume
  (`reflection.ts:383`).
- **Compile-rejection facts** are derived from the `output.produced` row.
  The row already carries each round's `compileFailures`
  (`output.ts:267`), so "the last round has an unresolved rejection" is a
  fold of rows plus the current reject-on-compile-failure setting, which
  reflection already re-reads on resume (`reflection.ts:286`). The one open
  point is the next round's prompt context: `formatCompileFailureRoundContext`
  reads the full `CompileResult`, not the stored failures. PR 3 either
  formats from the stored failures or adds the formatted text to the row.
  The second option changes the row schema and joins PR 5's format bump.
- **The workspace snapshot** (media assembly) is rebuilt per round by
  `opening` and `nextRound`, as `prepareRound` already does
  (`reflection.ts:411`). It is not persisted.

### Resume

Resume is the tool-use resume, reading the same rows. The one new case is a
crash between a round's completed turn and its `output.produced` row. The rule
is: when the folded state has a completed turn for round _n_ and no
`output.produced` for _n_, run the handler for _n_ before the idle decision.
The pipeline is already idempotent by round coordinate (`reflection.ts:893-897`),
so this replaces the `output.pending` phase with a fact derivable from rows.

## Parity checklist

Everything `reflection.ts` does, and where it lands:

| Behavior                                                      | Where                                         |
| ------------------------------------------------------------- | --------------------------------------------- |
| Round prompt, `userRequest` templates, TeXCount               | plugin `opening` / `nextRound`                |
| Input media on round 0, previous round's figures on round _n_ | plugin (**not in prototype**)                 |
| Compile-failure context in next round                         | plugin `nextRound`                            |
| Warn that declared `tools:` are not offered                   | plugin opening (unchanged text)               |
| Length continuation, 10-cycle cap, 1.5M input-token stop      | `loop/continuation.ts`                        |
| Overflow retry once per round after forced compaction         | `loop/continuation.ts` (**not in prototype**) |
| Output-token multiplier warning                               | `loop/continuation.ts`                        |
| Scratchpad extraction to transcript                           | plugin `afterTurn`                            |
| XML extraction, lineage, latexdiff, compile check, summary    | plugin `afterTurn` (moved as-is)              |
| Fallback that drops a round's outputs on pipeline failure     | plugin `afterTurn`                            |
| Missing-outputs instruction, open files, auto-open PDF        | plugin `afterTurn`                            |
| Reject-on-compile-failure outcome                             | idle policy `finish`                          |
| Relaunch a halted run if rounds remain                        | idle policy                                   |
| Configured `rounds` lowered since the snapshot                | idle policy (reads config)                    |
| Round stages `r0`, `r1` with index/total                      | stage label from the policy (about 5 lines)   |
| Run-workspace preparation before round 0                      | plugin `opening`                              |

## PR sequence

Each PR is green and shippable alone. Nothing changes user-visible behavior
until PR 4.

1. **Continuation-at-idle seam, goal mode as its first user.** Behavior-
   preserving; about +20 lines.
2. **Length continuation and overflow recovery in `loop/continuation.ts`**,
   for tool-use agents. This includes the continuation marker field. It
   changes tool-use behavior deliberately, and gets a CHANGELOG entry.
3. **The documents plugin extracted from `reflection.ts`.** Reflection calls it
   and still runs every workflow agent. `reflection.ts` shrinks by the output
   half. Behavior-preserving.
4. **Workflow agents run in round mode.** The category selects the round
   policy and the documents plugin, and new runs no longer call
   `launchReflectionRun`. A resumed run whose rows are in the `reflection`
   family still resumes through `reflection.ts`, until PR 5. This PR runs the bundled workflow agents live on the cheap test
   models, in both fresh and resumed runs.
5. **Delete `reflection.ts`, the `reflection` snapshot arm, the two phases and
   the resume family split.** This bumps `SESSION_EVENT_FORMAT`, which clears
   stored sessions of every kind (`Database.ts:1334-1343`), so it shares the
   next planned bump rather than forcing one of its own.

PRs 1–3 are worth landing even if 4–5 stop: PR 1 is the plugin seam goal
mode needs, PR 2 fixes cut-off chat answers, and PR 3 puts the documents
pipeline behind a boundary.

## Risks

- **Tool-use agents start continuing cut-off responses (PR 2).** A model that
  hits `length` mid-tool-call has no text to continue, so continuation applies
  only to text-only responses, as the prototype does. Anything else keeps
  today's behavior.
- **Format bump (PR 5).** Unfinished workflow runs from before the bump cannot
  be resumed, the same cost as every bump. Batching limits it to one wipe.
- **paper2slide** is only in the remote catalog, so the prototype did not
  run it. PR 4's live check must include it.
- **Round structure becomes less obvious to read.** In reflection the rounds
  are a visible `for` loop. In round mode they are "idle, then the policy
  opens the next turn". The idle policy and the documents plugin sit side by
  side in the output folder so a reader finds both.
- **Progress labels.** Until the stage label comes from the policy, workflow
  runs would show `t1/t2` instead of `r1/2`. The label change lands in PR 4,
  not after it.

## Not in scope

- Offering tools to workflow agents. Round mode makes it possible, since the
  loop already dispatches tools, but whether a documents agent should get
  tools is a product call for later.
- Top-level script launch (`texra run x.mjs`). It is a separate design.
- Manifest plugins contributing either seam. Both seams stay agent-runtime
  code until the owner rules on plugin hooks.

## Evidence

- Prototype diff and scratch runs: the 2026-09-24 agent-core study (not in the
  repo; the diff adds `loop/roundPolicy.ts`, 38 lines, and
  `output/documentRounds.ts`, 332 lines).
- Reflection-only bugs fixed the same day: #13150, #13157.
- Goal continuation at idle: `toolUse.ts:676-686`.
- Shared conversation across rounds: `reflection.ts:516-520`.
- Overflow recovery and continuation: `reflection.ts:566-741`.
