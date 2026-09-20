# Run-program and dispatch dedup: one mechanism, three copied skins

Date: 2026-09-20
Status: proposed
Baseline: `main` at `3378a967`. Parent survey:
[post-refactor architecture survey](../architecture/2026-09-20-post-refactor-architecture-survey.md).

## 1. Finding

There is one ledger, one fold, one provider caller and one child-run driver
(`startChildRunLoop` in `src/agent/runtime/childRunLoop.ts`); every strategy
passes through it. Workflow scripts are not a second orchestrator; they are a
second journal and attempt identity layered on the same driver. What is
duplicated is scaffolding, not architecture.

| Duplication                                                                                                                                                                                | Sites                                                                                                                                          | Lines                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Seven byte-similar pairs across the two loops: `fresh`, `openFresh`, `restore`, `snapshot`, `usageSnapshot`, `finalize`, `failure`, plus the resume-refusal block copied with its comments | `src/agent/runtime/loop/toolUse.ts` / `loop/reflection.ts`                                                                                     | ~180                                             |
| Two attempt vocabularies that share no schema machinery                                                                                                                                    | `childRunLoop.ts` `commitChildTurn` (`child.turn`) / `src/agent/workflowScript/checkpoint.ts` `recordWorkflowCallAttempt` (`workflow.attempt`) | ~120                                             |
| Three XML delivery-envelope formatters                                                                                                                                                     | `src/tools/delegation/subagentResults.ts`, `deliveryEnvelope.ts`, `src/tools/bash.ts`                                                          | ~200                                             |
| Two abort bridges onto one handle                                                                                                                                                          | `childRunLoop.ts` `ChildRunInterruptible` / `nativeSubagentStrategy.ts` `bindAbortSignals`                                                     | the two remaining `AbortController` ratchet rows |
| Two halt writers in one file                                                                                                                                                               | `reflection.ts` `finish` and `finalize`                                                                                                        | small                                            |
| A synthesized `flow.step` under a fake `family:'toolUse'` for agent-CLI children with no ledger                                                                                            | `childRunLoop.ts`                                                                                                                              | small                                            |
| Reflection output written to no row; results survive only inside the snapshot's family state                                                                                               | `reflection.ts` `roundsToPersisted`; `src/agent/implementations/flows/reflection/output/`                                                      | violates one-run-model R1                        |
| Two empty path segments                                                                                                                                                                    | `src/agent/implementations/flows/` holds only `reflection/`; there is no flow engine                                                           | 0                                                |

## 2. Changes

1. Lift the seven pairs into `loop/runProgram.ts` parameterised by family;
   `rows.ts`'s two snapshot constructors collapse to one.
2. Share the attempt schema machinery between `workflow.attempt` and
   `child.turn` without merging the facts. They answer different questions:
   `workflow.attempt` is the high-water and supersession authorization on
   the parent checkpoint aggregate, which survives child deletion;
   `child.turn` records accepted and settled turns on the child aggregate,
   and `workflowScriptAgentRunner` refuses replay after an accepted or
   ambiguously settled turn on that evidence. `ChildTurnState` stays. What
   PR 4 of the 2026-09-04 runtime note can still finish is one key type and
   one fold for the two rows.
3. One envelope builder in `deliveryEnvelope.ts`; the per-driver functions
   become fact selection only.
4. `ChildRunInterruptible` is the only `AbortController`; strategies take
   Effect interruption. Deletes `bindAbortSignals` and shrinks the ratchet.
5. Reflection output appends an `output.produced` row per round;
   `flow.snapshot`'s family state drops to scalars. Move the pipeline to
   `src/agent/output/` and delete the `implementations/flows/` segments.
6. Agent-CLI children get their own park row or none; stop borrowing
   `family:'toolUse'`.

## 3. Genuinely different, stays separate

Tool dispatch and its approval, duplicate and barrier protocol
(`loop/toolUseDispatch.ts`, no reflection analogue); the reflection
continuation cycle and byte-offset raw-output file; the QuickJS realm
boundary and its determinism guards; the external-process strategies
(Codex, Claude SDK, bash) whose cost and budget contracts sit outside TeXRA.

## 4. Acceptance

- `toolUse.ts` and `reflection.ts` each lose ~180 lines and import
  `runProgram.ts`.
- `workflow.attempt` and `child.turn` share one key type and one fold;
  both rows remain.
- One `formatDelivery` XML builder; `effect-migration-baseline.json` has one
  `new AbortController(` row.
- No production path contains `implementations/flows`.
