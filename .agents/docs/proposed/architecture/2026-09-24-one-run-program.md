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
| Tool-use loop              | `src/agent/runtime/loop/toolUse.ts` (+ `toolUseDispatch.ts`) | 796 (+ 974) |
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
   `toolUse.ts:679`). Rounds would be the second.
2. **After a turn, something processes the text.** This is the documents
   output pipeline, which becomes a plugin.

This proposal makes both of those seams explicit, moves the documents pipeline
behind the second one, runs workflow agents through the tool-use loop, and
then deletes `reflection.ts`.

A prototype (not merged) was measured twice on DeepSeek through the CLI:
once by the study that wrote it, and once by an independent review that
rebased it onto `394c301b0a`. The review's numbers:

|                                       | Reflection | Round mode |
| ------------------------------------- | ---------- | ---------- |
| Model calls (2-round polish)          | 2          | 2          |
| Ledger rows                           | 99         | 91         |
| Request bytes                         | —          | identical  |
| paper2slide (2 rounds, compile fails) | FAILED     | FAILED     |
| Crash in round 2, then resume         | 1 request  | 1 request  |

In both crash windows tested (during the round-2 request, and between a
round's response row and its `output.produced`), round mode re-issued only
the open request, byte-identical, and kept round 1's output. A round forced
to hit the output limit continued within that round in both modes. Prompt
cache hits depend on run order, because the provider cache is shared across
runs, so they are not a mode comparison.

The review also found six parity gaps, four reproduced live. They are folded
into the checklist below and marked **(review)**. The prototype does not
typecheck on current main (two TS2322 errors in `documentRounds.ts`).

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

- **The workflow category.** Agent YAML keeps `category: workflow`, and the 44
  production files that branch on it keep doing so for UI and output opening.
  The category now selects the documents plugin and round count instead of a
  loop. It also forces an empty toolset: `toolDefinitionsFor(run.setting.tools)`
  (`toolUse.ts:566`) would otherwise offer a workflow YAML's declared `tools:`
  (`agentSettingTools.ts:31-39`).
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
parking for a follow-up. Resuming a failed run must retry the round, as
reflection does by leaving the phase at `model.ready` (`reflection.ts:380-382`).
The prototype parked in `waiting` with `lastError` set, so its resume issued no
request and failed again at once **(review, reproduced)**. The policy's resume
path clears the error and re-opens the round's turn.

Round index and total come from the policy: index is `turn - 1`, never
`state.round`, which tool-use bumps on every model call (`toolUse.ts:586`).

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
`toolUse.ts` is exactly at its 796-line budget (`file-size-baseline.json:68`).
The idle seam of PR 1 lives in a sibling module for the same reason. From then on they apply to every
agent, and a chat agent cut off mid-answer continues too. That is a
behavior change for tool-use agents; see "Risks".

Two corrections to the prototype:

- **The continuation count is folded state (`continuationIndex`, per round
  since #13157), not a loop-local counter.** A resumed run must not get a
  fresh budget of 10.
- **A continuation turn is marked by a row field, not recognized by its prompt
  prefix.** The prototype's `roundTextOf` scans for `"Your response got cut
off"`, and a user could type that.
- **`continuationIndex` resets at `turn.begin`.** Tool-use never writes it
  today, and the fold checks monotonicity within one `round` only
  (`runRows.ts:155-164`).
- **Reflection's stop rules are kept exactly** (`reflection.ts:636-698`): no
  continuation once the text contains `</documents>`, none after a `length`
  cut that left empty text, the 1.5M input-token stop, and the prompt text
  "marked by </documents>". The prototype continued on any `length`, empty
  text included, and dropped that phrase from the prompt **(review)**. On a
  reasoning model whose budget went to reasoning, the empty case would loop
  10 times.
- **Cycles are joined with `connectResponseText`** (`reflection.ts:636-653`),
  a helper-model call on every host (`textConnection.ts:52-90`). The
  prototype concatenated raw text **(review)**. The call is skipped on cycle
  0, whose result reflection throws away.

`overflowRecoveredAtRound` (`runStateFold.ts:192`) exists in the fold, but it
is keyed on `state.round`, which tool-use bumps on every model call. Keyed
that way, "once" never holds, so the guard is re-keyed to the turn
**(review)**.

**Threshold compaction.** Tool-use compacts before every model call once the
history passes the threshold (`toolUse.ts:570-584`, default 75%,
`coreSettings.ts:67-70`). Reflection compacts only on provider overflow. On a
long paper, the default would summarize round 1's document before round 2,
which depends on it. Round mode turns threshold compaction off.

### State the plugin needs across resume

Reflection's family snapshot carries `totalRounds`, `compileFailureContext`,
`unresolvedCompileRejection` and a workspace snapshot. In round mode:

- **`totalRounds`** comes from configuration, as it already does on resume
  (`reflection.ts:383`).
- **Compile-rejection facts** are derived from `output.produced`. Each row
  carries the whole round collection, not one round (`runRows.ts:255-257`),
  including each round's `compileFailures` (`output.ts:267`). The rule is "the
  last round that ran a compile check", not the last row: an empty
  `compileFailures` also means "no outputs" or "the check itself failed under
  `recoverWarn`", and reflection keeps the earlier rejection in those cases
  (`reflection.ts:876-890`) **(review)**. That rule is a fold of rows plus the current reject-on-compile-failure setting, which
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
`roundOutputs` entry for _n_, run the handler for _n_ before the idle decision.
The pipeline writes the same files for the same round coordinate
(`reflection.ts:893-897`), so this replaces the `output.pending` phase with a
fact derivable from rows. It is not free of side effects: a rerun repeats
file-open requests, the missing-outputs instruction, latexdiff and the compile.
Reflection's `output.pending` re-entry repeats the same work. A round that
extracted nothing records an empty entry, so it does not rerun on every
resume.

Resume entry point after PR 5: `resumeToolUseFromResumeData` rejects non-tool-use
categories today (`executeAgent.ts`), and hosts resume workflows through
`runAgentRequest` (`hostRunActions.ts:598-605`). PR 5 widens the former to
both categories and points the latter at it.

### Child runs

A workflow agent run as a child is one child turn today only because
`launchReflectionRun` wraps the whole program in `options.turns.run(...)`
(`executeAgent.ts:247`). If round mode passed `turns` into `runToolUse`, each
round would call `beginTurn`, commit a `child.turn accepted` row and take a
budget permit (`childRunLoop.ts:1121-1127`), and `workflowScriptAgentRunner.ts:644-661`
refuses a child whose accepted turn never settled. So round mode keeps the
outer wrap: the launch for the workflow category wraps the whole round-mode
program in one child turn and does not pass `turns` inward. That wrap moves
into `executeAgent.ts`'s workflow branch when PR 5 deletes
`launchReflectionRun`. This was read, not run live.

## Parity checklist

Everything `reflection.ts` does, and where it lands:

| Behavior                                                      | Where                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Round prompt, `userRequest` templates, TeXCount               | plugin `opening` / `nextRound`                                   |
| Input media on round 0, previous round's figures on round _n_ | plugin (**not in prototype**)                                    |
| Compile-failure context in next round                         | plugin `nextRound`                                               |
| Warn that declared `tools:` are not offered                   | plugin opening, with the toolset forced empty                    |
| Length continuation, 10-cycle cap, 1.5M input-token stop      | `loop/continuation.ts`                                           |
| `</documents>` and empty-text stop rules, prompt text         | `loop/continuation.ts` **(review)**                              |
| `connectResponseText` between cycles                          | `loop/continuation.ts` **(review)**                              |
| No threshold compaction                                       | round policy turns it off **(review)**                           |
| Resume after a failed round retries the round                 | round policy resume path **(review)**                            |
| Overflow retry once per round after forced compaction         | `loop/continuation.ts`, keyed on the turn (**not in prototype**) |
| Output-token multiplier warning                               | `loop/continuation.ts`                                           |
| Scratchpad extraction to transcript                           | plugin `afterTurn`                                               |
| XML extraction, lineage, latexdiff, compile check, summary    | plugin `afterTurn` (moved as-is)                                 |
| Fallback that drops a round's outputs on pipeline failure     | plugin `afterTurn`                                               |
| Missing-outputs instruction, open files, auto-open PDF        | plugin `afterTurn`                                               |
| Reject-on-compile-failure outcome                             | idle policy `finish`                                             |
| Relaunch a halted run if rounds remain                        | idle policy                                                      |
| Configured `rounds` lowered since the snapshot                | idle policy (reads config)                                       |
| Round stages `r0`, `r1` with index/total                      | stage label from the policy                                      |
| Progress badge `r1/2` in every host                           | `flowPosition` reads the category **(review)**                   |
| CLI resume hint and history resumability                      | category check, not family **(review)**                          |
| Transcript does not show each round's document as the answer  | round mode skips `response.finalized` **(review)**               |
| Run-workspace preparation on every entry, resume included     | plugin, on every entry (idempotent)                              |
| Workflow child is one child turn                              | outer wrap in the workflow launch **(review)**                   |

## PR sequence

Each PR is green and shippable alone. Nothing changes user-visible behavior
until PR 4.

1. **Continuation-at-idle seam, goal mode as its first user**, in a sibling
   module of `toolUse.ts`. Behavior-preserving; about +20 lines.
2. **Length continuation and overflow recovery in `loop/continuation.ts`**,
   for tool-use agents. This includes the continuation marker field. It
   changes tool-use behavior deliberately, and gets a CHANGELOG entry.
3. **The documents plugin extracted from `reflection.ts`.** Reflection calls it
   and still runs every workflow agent. `reflection.ts` shrinks by the output
   half. Behavior-preserving.
4. **Workflow agents run in round mode.** The category selects the round
   policy and the documents plugin, and new runs no longer call
   `launchReflectionRun`. A resumed run whose rows are in the `reflection`
   family still resumes through `reflection.ts`, until PR 5. The
   user-visible items land here, not after: the progress badge
   (`runStatusDisplay.ts:180-190` and its six consumers), the CLI resume hint
   and history resumability (`cli/commands/workflow.ts:336`,
   `cli/runtime/toolUseResumeData.ts:98`), the Ctrl-C message (round mode
   printed "All fibers interrupted without error / This looks like a bug"),
   and the transcript rows. This PR runs `polish`, `correct` and
   `paper2slide` live on the cheap test models, fresh and resumed, and
   includes a resume after a failed round.
5. **Delete `reflection.ts`, the `reflection` snapshot arm, the two phases and
   the resume family split.** This bumps `SESSION_EVENT_FORMAT`, which clears
   stored sessions of every kind (`Database.ts:1334-1343`), so it shares the
   next planned bump rather than forcing one of its own. Scope: the other
   readers of the `reflection` family (`runStatusDisplay.ts:184`,
   `AgentRun.ts:262`, `SessionResumeRetrieval.ts:51`, the `RunFamily` enum at
   `runLedgerEvent.ts:46`) and the 11 test files that reference the family or
   `runReflection`. Nothing outside `reflection.ts` and the schema reads the
   two phases.

PRs 1–3 are worth landing even if 4–5 stop: PR 1 is the plugin seam goal
mode needs, PR 2 fixes cut-off chat answers, and PR 3 puts the documents
pipeline behind a boundary.

## Risks

- **Tool-use agents start continuing cut-off responses (PR 2).** Continuation
  applies only to text-only responses with non-empty text. A response cut
  mid-tool-call goes to dispatch as today. The continuation check runs before
  the final-tool forcing and the blank-after-tool-result prompt, in the
  prototype's order. A replayed `response.ready` with `length` appends the
  continuation once.
- **Format bump (PR 5).** Unfinished workflow runs from before the bump cannot
  be resumed, the same cost as every bump. Batching limits it to one wipe.
- **Round structure becomes less obvious to read.** In reflection the rounds
  are a visible `for` loop. In round mode they are "idle, then the policy
  opens the next turn". The idle policy and the documents plugin sit side by
  side in the output folder so a reader finds both.
- **Progress labels come from the snapshot family, not the stage.** The
  prototype already opened stages named `r0`/`r1`, and the CLI still showed
  `[t1]`/`[t2]` and an `Idle` state between rounds. The fix is in
  `flowPosition`, not the stage label.
- **A pre-existing silent result.** In reflection today, with a small max
  output (400 or 900 tokens) and a reasoning model, the run completes with
  zero outputs and no continuation. This is not caused by the proposal. It is
  a separate bug, found while testing.
- **Reflection's resume makes helper calls a fresh run does not.** A resume
  made two `connectResponseText` helper calls that a fresh `texra run` did
  not. This is unexplained, and PR 2 should find out why before porting the
  connector.

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
- Independent review, 2026-09-25, at `394c301b0a`: 20+ live DeepSeek CLI runs
  (polish, correct, paper2slide, forced continuation, SIGKILL and SIGINT with
  resume, relaunch of a completed run, resume after a forced 400). The ledger
  was compared by SQLite queries and the wire bodies byte for byte, and
  `ReflectionLoop.vitest.ts` passed 29/29. Child runs, media per round,
  declared-tools dispatch and compile-rejection edge cases were read, not run.
- Reflection-only bugs fixed the same day: #13150, #13157.
- Goal continuation at idle: `toolUse.ts:678-686`.
- Shared conversation across rounds: `reflection.ts:516-520`.
- Overflow recovery and continuation: `reflection.ts:566-741`.
