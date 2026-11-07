# Design red-flag audit, round 6 (read-only): two areas spread across layers

Rounds 1 to 5 (`../2026-11-05-design-red-flags/`,
`../2026-11-06-design-red-flags-round-2/`,
`../2026-11-07-design-red-flags-round-3/`,
`../2026-11-07-design-red-flags-round-4/`, the round-5 docs and prompts
reports) and the lens audits (`../2026-11-07-design-red-flags-lenses/`)
audited by directory and by lens. Round 6 audits two areas no directory audit
could see whole, because each is spread across the schema, the run loop, the
session store, the view fold and the hosts: the stages (formerly "task
groups") and the session database.

The rules, the red-flag species and the output format are round 2's
(`../2026-11-06-design-red-flags-round-2/BRIEF.md`, "The red flags" and
"Output format"), with round 3's and round 4's additions
(`../2026-11-07-design-red-flags-round-3/BRIEF.md`,
`../2026-11-07-design-red-flags-round-4/BRIEF.md`): the commit read is stated
at the top; a finding already in an earlier round, a lens audit, the
catalogue (`../2026-11-07-design-red-flags-lenses/catalogue.md`) or
`.agents/docs/refuted-candidates.json` is found, cited and not repeated; the
report ends with an Effect-native mapping and an owner per finding. Round 6
adds four rules:

- **Names.** PR #14833 (re-run as branch `claude/b-names-2`) renames
  `TaskGroup*` to `Stage*`, `taskGroups` to `stages`, `TaskGroupList` to
  `StageList` and `parentGroupId` to `parentStageId`. Report with the new
  names and say which commit was read; a citation is to the file as it
  stands on that commit.
- **Answer the area's questions with `file:line` evidence**, then give 6 to
  12 findings, each with its red flag, consumer counts, the fix and its size.
- **Design it twice.** The report compares two designs for the area as it
  would be built with today's knowledge and chooses one.
- **A ranked fix plan** of one PR (two when a step waits on another PR),
  naming the files it touches, followed by a "Good, left alone" section. The
  fix session follows "What every owner follows" in
  `.agents/docs/proposed/architecture/2026-11-07-red-flags-round-2-and-order.md`.

## Areas

| Area | Report                  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S    | `S-stage-area.md`       | The stage, end to end: its schema (`shared/schemas/taskGroup.ts`, renamed `stage.ts`), the `stage.*` rows (`sessionEvent.ts`, `traceEvent.ts`), its status (`run.ts`), the transcript fold and view (`transcriptUpdate.ts`, `transcriptState.ts`, `sessionView.ts`, `sessionViewUpdate.ts`, `runRowReads.ts`, `runState.ts`), the transcript rows and the script-stage model (`shared/transcript/`), the trace (`agent/trace/`), the loop's writers (`loop/toolUseDispatch.ts`, `loop/rows.ts`, `loop/runProgram.ts`, `executeAgent.ts`, `processRun.ts`), the publisher (`SessionEvents.ts`, `controllers/session/runTrace.ts`), the progress view (`TaskGroupList.ts`/`StageList.ts`, `LogList.ts`, `groupStyles.ts`, `statusIcons.ts`) and the CLI (`transcriptEntryLayout.ts`, `ConversationPane.tsx`, `App.tsx`, `sessionProgressSubscription.ts`, `WorkflowRunDetails.tsx`). Key questions: what a stage is and how many representations it has; what the renderers derive that the data should carry; whether its status duplicates the run's and who maps it; whether `kind` is a special case written as data; whether the parent edge is one fact; where the loop opens and closes a stage; what the trace restates. |
| T    | `T-session-database.md` | The session database against pi-durable: `packages/harness/src/controllers/session/` (`Database.ts`, `storeSchema.ts`, `rowCodec.ts`, `rowReader.ts`, `sessionStore.ts`), `shared/schemas/rowVersions.ts`, the session log and its publisher. Audited by a separate session. Key questions: what the store hand-rolls that a durable event-log design gives by construction (append, subscription, projection, version per record kind); which facts the database holds twice; what a new row kind touches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
