# Round 4, area Y: the red flags today's merged diffs added

Read at main `363d484` (the worktree `/home/user/wt-audit`), against the diff
`ca1431e..363d484`: the ten PRs #14799, #14801, #14802, #14803, #14804,
#14805, #14806, #14807, #14809, #14810. Only added lines and new or rewritten
modules were judged; a flag a PR removed is not listed. Effect usage was
checked against `node_modules/effect` 4.1.2. Read-only: no code changed, no
tests run.

Owners: A (CLI and approvals), B (desktop, extension, UI), C (plugins and
documents), E (harness core and llm), F (tooling, and the author of #14810's
three rewrites).

## Numbers

Lines changed in `packages/*/src`:

| Package      | Added | Removed |
| ------------ | ----: | ------: |
| texra        | 2,187 |   2,129 |
| harness      | 1,518 |   1,575 |
| cli          | 1,104 |   1,105 |
| desktop      |   655 |     755 |
| extension    |   164 |     315 |
| llm          |    77 |      66 |
| trace-viewer |     9 |       6 |

The largest rewrites: `texra/src/telemetry/UsageLogService.ts` (787 lines
changed), `desktop/src/renderer/editorPane.ts` (663),
`harness/src/agent/runtime/HostInteractions.ts` (378),
`harness/src/tools/bash.ts` (307), `cli/src/chat/tui/commands/slashRegistry.ts`
(306), `harness/src/tools/toolAvailability.ts` (281).

Comment share of the rewritten files of 200 lines or more:
`sessionExitController.ts` 116/337 (34%), `toolAvailability.ts` 91/330
(27%), `UsageLogService.ts` 146/593 (24%), `slashRegistry.ts` 79/319 (24%),
`HostInteractions.ts` 90/383 (23%). `bashDelivery.ts` (147 lines) is 31%.

Primitives in `src` lines, added / removed: `Deferred` +4/−22,
`forkDetach` +3/−21, module-level and closure `let`s +8/−20,
`withPerKeyLane` +2/−7, `FiberHandle` +11/−1, `FiberSet` +10/−0,
`SubscriptionRef` +18/−4, `PubSub` +6/−1, `RcMap` +4/−0, `Semaphore` +5/−4,
`Effect.uninterruptible` +1/−2, `instanceof` +11/−7, `Effect.ignore` +1/−0,
`Effect.orElseSucceed` +1/−0. The added lines contain no `Layer.scoped`, no
`new Promise`, no `.then(`, no `unknown` error channel, and one
`Effect.context<…>()`, forwarded through `Context.pick`
(`toolAvailability.ts:168-173`).

Of 139 export lines the diff adds, most are renames of existing exports
(N3, N5). Those that are new and have at most one consumer outside their file
are listed under batch B below.

**Verdict.** Today's code is mostly clean. The PRs replaced hand-written
waiters, counters and flags with `FiberHandle`, `FiberSet`, `RcMap`,
`SubscriptionRef` and `Queue`, and the Effect usage checks out. The new flags
are of three kinds:

- a rule promoted to a public "one rule" that the enforcing code does not use
  (finding 1);
- two policies for one failure, where a fix left the old path beside the new
  one (findings 2, 3 and 6);
- options and failure branches that nothing exercises any more (findings 4,
  5 and 7).

## Ranking

| #   | Title                                                                                                      | Flag                                              | PR      | Owner |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------- | ----- |
| 1   | `launchPolicy` is called the one rule, but the harness enforces a different one                            | two representations; false comment (public)       | #14809  | A     |
| 2   | A malformed GitHub body skips one read and fails the whole poll on the next                                | two policies for one failure                      | #14805  | C     |
| 3   | The background shell's delivery reads its rows back but cannot read them without the writer's counters     | information leakage; two representations          | #14810  | F     |
| 4   | The usage log's `enabled` gate and `config` option have no caller; two comments say a host sets them       | option for a special case; false comments         | #14810  | F     |
| 5   | The agent catalog's miss is a `LaunchRefused` carrying a UI notice; four of five callers translate it back | special code in a general module; repetition      | #14809  | A     |
| 6   | A bound file is located three times and its absence is handled three ways, one of them silently            | information leakage; silent fallback              | #14805  | C     |
| 7   | Tool availability builds a failure path for a round that its own comments say cannot fail                  | error not defined out of existence; false comment | #14810  | F     |
| 8   | The CLI's stdin lane is a per-key lane with one constant key, on the day #14799 removed the same shape     | general code used for its special case            | #14809  | A     |
| B   | Exports with no consumer, or one, and dead fields                                                          | overexposure                                      | several | —     |
| C   | Names and comments                                                                                         | vague name, false or restating comment            | several | —     |

---

## Finding 1. `launchPolicy` is called the one rule, but the harness enforces a different one

**PR:** #14809 (U2). **Owner:** A.

**Red flags:** two representations of one fact (what policy a launch's run
runs under); a false comment on the public surface; information leakage (the
CLI and the composer read a prediction, not what enforcement reads).

**Evidence.**

- `harness/src/shared/approvalBypassKind.ts:74-84`, exported from `/schemas`
  (`schemas.ts:168`, `docs/api/schemas.md:1025-1036`):

  > The policy a launch's run runs under: the project's, narrowed by the
  > limit the launch asks for, or Auto-approve, which widens its own task
  > but never over Block.

  It returns `'yolo'` for `'autoApprove'` under any project policy but
  `'never'`.

- The harness never calls it (`git grep launchPolicy -- packages/harness/src`
  finds only its definition and a comment at `runtimeRequest.ts:312`).
  `rootLaunch` (`agent/runtime/rootLaunch.ts:122-131`) turns Auto-approve
  into a human grant on every bypass kind and sets no policy. Enforcement
  reads `owners.approvals.policy(runId)` (`requests.ts:146`), which is
  `runPolicy(project, view, runId)` (`runApprovalQueue.ts:190-198`). Under
  an Auto-approve launch and an Ask project, that is `'ask'`.
- What the two disagree on: `answerFor` (`requests.ts:140-180`) denies a
  question and a retry under `'yolo'` (`approvalPolicy.ts:128-135`,
  `:89-103`). Under the enforced `'ask'` it presents them. A plan approval
  agrees, because the agent-work grant covers it (`loop/toolGuard.ts:71-77`,
  `plan: 'superYolo'`). Of the six request kinds, the prediction is right
  for four (bash, edit, proposal, plan approval) and wrong for two
  (question, retry); a plugin request goes to a person either way.
- Readers of the prediction, 2 direct and 5 through the CLI's
  `effectiveApprovalPolicy` (`cli/src/runtime/cliContext.ts:538-545`):
  - `CliContext.approvalPolicy` (`cliContext.ts:64-67`, "The policy this
    invocation's launches run under", and `:469`). The headless guards read
    it (`commands/team.ts:139`, `commands/_helpers/runInstructions.ts:115-118`),
    so an Auto-approve run is treated as `yolo` and gets no "prompts cannot
    be answered" guidance.
  - The TUI status bar and the resume hint (`chat/tui/runChatTui.tsx:267`,
    `:332`, `:594`) show "Auto-approve" while the run still presents
    questions and retries.
  - The composer (`texra/src/ui/progress/components/composerChipMenus.ts:259-261`)
    calls `launchPolicy(policy, 'autoApprove') !== 'never'`, which is
    `policy !== 'never'`.

**The design decision behind it.** #14809 moved the CLI's own approximation
(`effectiveApprovalPolicy`, from before U2) into the harness and named it the
one rule. The rule that enforcement follows was already in the harness, in
`rootLaunch` (what a launch records: grants and a limit) and in
`runPolicy`/`resolveBypass` (how they are read). So there are two statements
of the rule, and they agree only for `'never'` and `'ask'`.

**The better design.** The rule stays where enforcement reads it, and a host
reads that.

- Export a pure `launchGrants(approval)` from `/schemas`, returning
  `{ limit?: ApprovalPolicyLimit; grantAll: boolean }`. `rootLaunch.ts:122-131`
  calls it instead of switching on the literal itself.
- What a run runs under is then `runPolicy` plus `runBypasses` over the
  view, which the GUI header already shows (`RUN_GRANT_COPY`).
- The CLI keeps the project policy narrowed by the limit as
  `approvalPolicy`, with an `autoApprove: boolean` beside it. The status bar
  shows the policy and the grants ("Ask · Auto: edits, commands, agent
  work").
- The headless guards ask whether a question or retry could reach nobody,
  which Auto-approve does not prevent.

Deleted: `launchPolicy` (2 production consumers, plus its `/schemas` export
and API-report entry); `effectiveApprovalPolicy`'s `'yolo'` result (5 call
sites read a corrected value); the composer's call (it becomes
`policy !== 'never'`).

**What we give up.** The single "Auto-approve" status word in the TUI. It
was wrong for questions and retries.

**Change amplification.** Take "a request kind a grant does not cover" (a
new human-input kind that `'yolo'` denies). Today it silently contradicts the
`'yolo'` prediction in the CLI's guards, status and resume hint: 3 files to
notice and fix. After: 0, because the hosts read what enforcement reads.

**Depends on:** none.

---

## Finding 2. A malformed GitHub body skips one read and fails the whole poll on the next

**PR:** #14805 (NC6). **Owner:** C.

**Red flags:** two policies for one failure (two decodes, two outcomes); a
parameter whose value at half the calls means "do not do this"; the landed
design diverges from the finding it closes.

**Evidence.**

- `ghGet(path, schema, etag?)` (`texra/src/tools/github/githubClient.ts:152-160`)
  now decodes the 200 body and turns a decode failure into
  `GitHubTransientError` (`:192-203`). The poll loop retries that error with
  backoff and detaches the subscription after 24 h without a success
  (`poller.ts:105-133`, `:188`).
- `validateOrSkip` (`poller.ts:227-243`) states the opposite rule for the
  same failure:

  > a bad body skips what it feeds instead of counting as a failed poll that
  > would eventually drop a reachable target.

- 8 of the 15 `ghGet` calls pass `Schema.Unknown` and decode a second time
  themselves:
  - `checkRunsClient.ts:342`;
  - `issuePoller.ts:56`, `:62`;
  - `pullPoller.ts:142`;
  - `repoPoller.ts:162-164`, `:388`.

  Seven of those go through `validateOrSkip`; `repoPoller.ts:390` decodes
  by hand. The doc comment admits the sentinel (`githubClient.ts:155`: "A
  caller that skips a malformed body itself passes `Schema.Unknown`").

- One function, two outcomes. In `pollPull`, a malformed pull-request body
  skips the poll and keeps the ETag (`pullPoller.ts:142-151`). A malformed
  comments, review-comments or reviews body (`:193-212`, which now pass
  schemas) fails the whole poll as transient, so the PR's merge and CI
  events wait on the backoff too. `checkRunsClient.ts:163-166` (transient)
  and `:341-345` (skip) split the same way.
- NC6's design (`2026-11-07-design-red-flags-lenses/nonobvious-code.md:482-487`)
  asked for one outcome: "A decode failure is a typed `SchemaError` in the
  `GitHubFailure` union, which the pollers already log and skip." The commit
  chose "a transient failure … which a poll retries" (#14805's message) and
  left the skip path in place.

**The design decision behind it.** The question "what does a malformed body
mean to a poll" was answered twice, once in the client and once in the
pollers, and each call site picks one answer by choosing its second argument.

**The better design.**

- `ghGet` always decodes, and fails with its own tag, `GitHubMalformedBody`
  (path and issue), in `GitHubFailure`.
- A poll decides what that means once. Where one resource must not block
  another (`issuePoller.ts:70-74` keeps the issue and its comments
  independent), the call wraps itself in
  `Effect.catchTag('GitHubMalformedBody', logAndSkip)`.
- A tool call (`githubSubscriptionTool.ts:263`) lets it fail.

Deleted: `validateOrSkip` (8 calls), the `Schema.Unknown` sentinel (8
calls), the hand decode at `repoPoller.ts:390-397`, and the comment at
`githubClient.ts:155`. Each call passes the schema its type comes from.

**What we give up.** Nothing. The skip-or-fail choice becomes visible at the
call, as a `catchTag`, instead of hidden in the second argument.

**Change amplification.** Take "change what a malformed body does to a poll".
Today: the transient branch (`poller.ts:188`), `validateOrSkip`, and the
choice at 15 calls. After: one `catchTag` helper.

**Depends on:** none.

---

## Finding 3. The background shell's delivery reads its rows back but cannot read them without the writer's counters

**PR:** #14810 (V-R11, M6). **Owner:** F (harness core; E reviews).

**Red flags:** information leakage (the row layout past the cap is known to
the writer, the delivery formatter and a comment); two representations of
where the gap in a stream is (the rows' position and the in-memory counters);
temporal coupling (the delivery waits on the whole session log's barrier).

**Evidence.**

- The writer keeps per-stream counters, `{ recorded, elided, tail }`
  (`harness/src/tools/bash.ts:161-217`). At the end it reads every display
  row of the run back (`:232-235`, `log.settled` then `log.display(runId)`)
  and passes the counters along as `gaps: streams` (`:240-243`).
- `formatBashDelivery` (`agent/runtime/delegation/bashDelivery.ts:54-124`)
  joins the stream's `process.output` rows and cuts them at `recorded`:
  `text.slice(0, recorded)` for the head and the rest as the tail (`:97-103`).
  The rows do not say where the gap is, so the counters must.
- The cut is right only while every row the writer published is present.
  `SessionLog.lost(runId)` exists because a row can be refused by the store
  (`shared/session/sessionLog.ts:71-73`). One missing chunk moves the cut
  and splits the head and tail in the wrong place, with no error.
- To serve the writer, the two budgets became exports of the delivery module
  (`bashDelivery.ts:25`, `:36`; one consumer each, `bash.ts:17-18`). The
  shared constant's comment restates their values as prose
  (`shared/toolUse.ts:170-179`: "its first 1,000 characters", "the last
  12,000 characters").
- `/executions/{id}/output` projects the same rows a second way
  (`tools/executions/processOutput.ts:45-102`). There, the notice row is
  where the gap is; the delivery filters notice rows out
  (`bashDelivery.ts:90-96`).
- A capped run whose crossing chunk fits in its stream's head budget ends
  with the notice "[0 characters elided; the last 0 follow]"
  (`bash.ts:209-216`; for example, stdout at 199,900 characters, then 500
  characters of stderr).
- M6's design (`2026-11-06-design-red-flags-round-2/M-harness-tools.md:393-407`)
  was a pure projection that gave up the output past the cap. Review asked to
  keep the real tail past the cap (#14810's last commit), which needs a gap
  the rows cannot express. The landing kept both the projection and a
  capture.

**The design decision behind it.** The delivery was made a projection of the
rows, but the rows do not record the one fact the projection needs (where
the writer stopped recording), so the writer's memory still answers it.

**The better design.** One of two, chosen by whether a stored-row change is
acceptable now.

- (a) The rows say where the gap is: past the cap, the writer records a
  structured gap row per stream (its elided count) before the tails. Then
  `formatBashDelivery(rows)` and `projectProcessOutput` read one layout, and
  `gaps`, the `recorded` cut and the two exports go. This is a row format
  change, so it rides R2's golden-store regeneration.
- (b) The writer owns the excerpt: it keeps each stream's first 1,000
  characters and its rolling tail, which it already keeps past the cap. It
  hands `formatBashDelivery` `{ head, tail, elided }` per stream, never
  optional, and writes the tails as rows for `/executions` as it does now.
  The read-back (`log.settled`, `log.display`, the `SessionLog` dependency of
  the turn) goes, and the budgets return to file-local constants in
  `bash.ts`.

(b) can land alone; (a) is the end state if the rows should be the only
record.

**What we give up.** (a): a stored-row kind. (b): the claim that the
delivery is a projection of the rows. Since the rows already end with the
tails, they and the delivery still say the same thing.

**Change amplification.** Take "change the head budget or the cap policy".
Today: `bash.ts`, `bashDelivery.ts` and the `toolUse.ts` comment, 3 files.
After: 1.

**Depends on:** (a) on R2's storage-format PR; (b) none.

---

## Finding 4. The usage log's `enabled` gate and `config` option have no caller; two comments say a host sets them

**PR:** #14810 (V-R12, G9). **Owner:** F.

**Red flags:** an option for a special case (a knob only a test turns, and
one nobody turns); false comments.

**Evidence.**

- `UsageLogConfig` (`texra/src/telemetry/UsageLogService.ts:64-74`) has
  `batchSize`, `flushIntervalMs` and `enabled`. `enabled` is read at `:331`,
  `:504` and `:589`.
- No host can pass `config`: the process layer types it away
  (`texra/src/controllers/texraProcessLayer.ts:60`,
  `readonly usageLog: Omit<UsageLogOptions, 'config'>`). The three hosts pass
  only `version`, `editorType` and, on the extension, `hostTelemetryEnabled`
  (`desktop/src/main/platform/index.ts:94-97`,
  `cli/src/runtime/cliProcessRuntime.ts:197-200`,
  `extension/src/extension.ts:149-154`).
- The one test passes `enabled: true`, the default
  (`src/test-kernel/telemetry/UsageLogService.vitest.ts:95-99`), and batch
  sizes 1 and 100 (`:96`, `:152`). No caller anywhere passes
  `enabled: false`: 0 of 4.
- Before #14810, the close wrote `config.enabled = false`, so the field had
  one writer. #14810 moved that job to `Queue.end` (`:534`) and kept the
  field as a "constant of the program" (its commit message). It is now
  always `true`.
- False comments:
  - `:111-115`: "`config.enabled` remains a separate, independent gate so a
    host (or a test) can hold the service off regardless of user settings."
  - `:281-282` (new in #14810): "Batch size, flush cadence and the host-side
    off switch; the shipped defaults stand where a caller passes nothing."
  - `:271`: "the cadence a test overrides" is the only true part.

**The design decision behind it.** A switch that existed for the close's
bookkeeping outlived the bookkeeping.

**The better design.**

- Delete `enabled`: the field, its default, the three reads, the start
  log's mention, and the comment at `:114-115`.
- The cadence knob is test-only. Either the suite runs on the shipped
  defaults (10 entries per batch, the 30 s interval under its fake timers)
  and `config` goes, or it stays as a cadence for tests and says so in one
  line.
- `hostTelemetryEnabled` stays: it is one host's real fact.

**What we give up.** Nothing in production.

**Change amplification.** Take "a host wants its own off switch". Today a
reader finds `enabled`, which looks like that switch but cannot be passed,
and the real one, `hostTelemetryEnabled`: 2 candidates. After: 1.

**Depends on:** none.

---

## Finding 5. The agent catalog's miss is a `LaunchRefused` carrying a UI notice; four of five callers translate it back

**PR:** #14809 (Q5). **Owner:** A.

**Red flags:** special code in a general module (the catalog raises the
launch's error, with presentation data); repetition (the same refusal built
twice, worded two ways); a name that misleads its reader.

**Evidence.**

- `forLaunch`'s miss (`harness/src/agent/index/agentCatalog.ts:352-373`)
  now fails with `LaunchRefused` and builds the host notice
  `{ event: 'agentNotFound', payload }`. #14809 deleted the catalog's own
  `AgentNotFound` (with its `agent` field) for this.
- Callers of `forLaunch`, 5 in all. Four catch the error and turn it back
  into "not found" in their own terms:
  - `cli/src/runtime/agents.ts:53-62`, into `CliUsageError`;
  - `harness/src/agent/runtime/resumeBlocker.ts:39-41`, into `undefined`.
    No launch is involved, yet the line reads "ignore a refused launch".
  - `texra/src/agent/output/documentRecipe.ts:142-147`, into
    `DocumentTaskRefused`;
  - `texra/src/controllers/mainView/backend/MainViewRunLaunchController.ts:59-66`,
    into `{ entry: null }`.

  Only `AgentLaunchContext.ts:64-71` lets it propagate.

- The same refusal is also built at the session's input check,
  `sessionPrograms.ts:117-126`, worded "Agent "X" was not found in the
  configured agent directory." The catalog says "Could not find agent: X"
  plus the load failure and skipped files (`agentCatalog.ts:233-242`).
  Two constructions of one notice, two wordings, and only the catalog's
  rescans on a miss (the input check reads `AgentCatalog.get` without
  rescanning, `sessionPrograms.ts:117-120`).

**The design decision behind it.** Q5 asked for one error at the session's
launch boundary. The landing pushed that error down into the lookup, so the
lookup now speaks the vocabulary of one of its callers.

**The better design.**

- `forLaunch` answers `AgentEntry | undefined` after its rescan. A miss is a
  value for four of five callers.
- One constructor, `agentNotFound(identifier, detail)`, builds the
  `LaunchRefused` with its notice. `AgentLaunchContext` and the session's
  input check both call it, with the catalog's detailed message.
- Deleted: the notice and `LaunchRefused` in `agentCatalog.ts`, the four
  `catchTag('LaunchRefused', …)` translations (each becomes `if (!entry)`),
  and the second wording.

**What we give up.** Nothing. The launch keeps its single error kind.

**Change amplification.** Take "a sixth caller that resolves an agent
without launching". Today it must know that `LaunchRefused` from the catalog
means "not found": 1 hidden convention. After: none.

**Depends on:** none.

---

## Finding 6. A bound file is located three times and its absence is handled three ways, one of them silently

**PR:** #14805 (T2). **Owner:** C.

**Red flags:** information leakage (how a bound file is found, written at
three readers); a silent fallback (`Effect.orElseSucceed` over a failed
read); two definitions of which files a task binds.

**Evidence.**

- `boundFiles` (`harness/src/tools/toolTable.ts:185-194`) returns names
  "relative to it", so each reader resolves them itself, and each handles a
  missing file its own way:
  - the scan's digest (`agent/index/agentYamlScanner.ts:229-237`),
    `path.resolve(path.dirname(yamlPath), file)`. Any read failure becomes
    `Effect.orElseSucceed(() => \`\0${file}\`)`: no log, and EACCES treated
    like absence.
  - the copy (`agent/index/AgentDirectoryService.ts:386-418`),
    `path.resolve(fromDir, file)`. It rejects a file outside the agent's
    directory, and `copyFile` fails loudly on a missing one.
  - the run (`texra/src/tools/documents/documentTask.ts:84-133`) does not use
    `boundFiles`: it walks `task.files` itself and resolves each against the
    agent's directory, allowing an absolute path. A missing file is warned
    and marked not ok on the card, and the template variable renders empty.
- Which files a task binds is written twice:
  `DOCUMENT_TASK_BLOCK.files` filters `file !== ''`
  (`texra/src/shared/plugins/documents.ts:175-176`), and `taskFileVars`
  skips `!filePath` (`documentTask.ts:98`).
- The silent read feeds the newer-version check. The digest covers the bound
  files, "so a changed bundled template raises the newer-version notice"
  (#14805's message), and the copy stamps `base.digest`
  (`AgentDirectoryService.ts:370-371`, `:419`). A bundled `criticize.tex` that is
  unreadable for one scan changes the bundled digest without a word, so a
  stamped custom copy reads as out of date.

**The design decision behind it.** T2 made bound files part of an agent
without giving them one reader: "where is this file, and is it there" is
answered by the scan, by the copy and by the run.

**The better design.**

- `boundFiles(entry)` answers absolute paths, resolved once against the
  agent file's directory, with the copy's "inside the directory" rule
  applied there.
- The run reads its bound files through it, with the block naming the
  variable for each path.
- The scan reads absence with `absentReason`
  (`harness/src/utils/files/fsEntryExists.ts`, the one reading of "nothing
  is there"): an absent file is digested by name, as now, and any other
  failure is a scan error the catalog already reports.
- Deleted: two `path.resolve(path.dirname(…))` spellings, the second `''`
  filter, and the `orElseSucceed`.

**What we give up.** An absolute `task.files` path, which the copy already
rejects. Or the run keeps allowing it and the resolver names that one
exception.

**Change amplification.** Take "a second plugin block that binds files".
Today it must restate the location rule and pick a missing-file policy
beside the scan's and the copy's: 3 rules. After: 1.

**Depends on:** none.

---

## Finding 7. Tool availability builds a failure path for a round that its own comments say cannot fail

**PR:** #14810 (V-R10, M1). **Owner:** F.

**Red flags:** an error not defined out of existence; comments that
contradict each other.

**Evidence.**

- A round probes each plugin inside `probeToolGroup`, which turns every
  failure and every defect into that group's `unknown` (`:289-329`). Each
  group borrows its plugin's services first, through
  `catalog.processServices(plugin.id)`
  (`harness/src/tools/toolAvailability.ts:183-188`), and that call sits
  outside the catch.
- `processServices` is `RcMap.getOption` over the plugin layers
  (`liveTools.ts:194-195`). While an entry is still being built, it "fails
  with the same error as `get`" (`effect/dist/RcMap.d.ts:532-536`). A
  plugin layer that dies while starting (`buildPluginLayer`,
  `sessionTools.ts:113-129`, error type `never`, so a defect) therefore
  fails the whole `Effect.forEach`, interrupts every other group, and
  publishes no results.
- The comments disagree:
  - `:190-191` says "no group's failure cancels a sibling, because each one
    resolves to a result of its own".
  - `:234-236` says "A round that fails (a plugin layer's start failing under
    it) gives its waiters that failure", and the code builds for it: an
    `Exit` in every answer (`:205-211`), `Effect.exit` (`:237`), and
    `refresh` re-raising it (`:275-278`).
  - The service's comment says `refresh` "never fails"
    (`toolAvailabilityService.ts:44-45`).
- The same comment promises "Tools recently found missing are looked up
  again" (`toolAvailabilityService.ts:43-44`). #14810 deleted the last
  mention of the miss cache that sentence refers to (the old `hold`
  comment), and no cache is left in `packages/*/src`.

**The design decision behind it.** One call stayed outside the boundary that
makes each group's result its own, so the round kept a failure case and the
code built machinery for it.

**The better design.**

- Borrow the plugin's services inside `probeToolGroup`'s catch, so one
  plugin's layer failure is that group's `unknown`. A round then cannot
  fail.
- The answers carry `ProbeResults`, not `Exit`.
- `Effect.exit` and the comment at `:234-236` go, and `refresh` returns the
  results.
- Drop the miss-cache sentence.

**What we give up.** Nothing. A failed layer start is still logged, as that
plugin's probe failure.

**Change amplification.** Take "a plugin whose process layer can fail to
start". Today it costs every plugin's round on that root. After: its own
badge.

**Depends on:** none.

---

## Finding 8. The CLI's stdin lane is a per-key lane with one constant key, on the day #14799 removed the same shape

**PR:** #14809 (PT3). **Owner:** A.

**Red flags:** general code used for its special case; a primitive hand-fed
where the plain one exists.

**Evidence.**

- `provideCliInvocation` (`cli/src/runtime/cliContext.ts:128-132`) builds
  `onPromptLane: withPerKeyLane(new Map<'stdin', PerKeyLane>(), 'stdin')`:
  a lane map that only ever holds one key.
- #14799 replaced the desktop's one-key lane (keyed by a Symbol) with
  `Semaphore.make(1)` the same day (`desktop/src/main/desktopProjects.ts:305`;
  that PR's "the desktop's selection lane is one Semaphore").
- `EFF-ADOPT-per-key-lane-semaphore` (`.agents/docs/refuted-candidates.json`)
  keeps `withPerKeyLane` where its claim order or `refuseClaim` matters. The
  stdin lane has no `refuseClaim`, and the prompts it orders come from
  concurrent fibers whose relative order is arbitrary already.

**The better design.** `onPromptLane: Semaphore.makeUnsafe(1).withPermit`
(`effect/dist/Semaphore.d.ts:217`). Deleted: the `PerKeyLane` import and the
one-key map.

**What we give up.** Strict FIFO between two prompts raised in the same
instant, which the refutation measured at 2 of 2,101 claim offsets. Nothing
depends on that order.

**Change amplification.** None; this is a readability fix.

**Depends on:** none.

---

## B. Exports with no consumer, or one, and dead fields (batched)

Consumers are counted outside the defining file in `packages/*/src`, then in
tests.

| Symbol                                                                       | Consumers (src, tests) | PR     | Owner | Note                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------- | ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionInteractions` (`harness/src/agent/runtime/HostInteractions.ts:191`)  | 0, 0                   | #14802 | A     | The service's shape. `Interactions['Service']` names it. File-local.                                                                                                                                                   |
| `RunLoopPhase` (`harness/src/shared/session/runState.ts:99`)                 | 0, 0                   | #14809 | A     | Moved beside its one reader by N3 and kept its export.                                                                                                                                                                 |
| `subscribeAppSignal` (`harness/src/platform/appSignals.ts:221`)              | 1, 0                   | #14810 | F     | One consumer (`toolAvailability.ts:214`). The module's own comments point to `AppSignals`' `subscribe` instead (`:34-35`, `:245-246`). Name it there, or keep it file-local and export only what the host entry needs. |
| `OrderedRuleSet` (`texra/src/replacement/types.ts:33`)                       | 1, 0                   | #14805 | C     | Built and read only in `engine.ts`. Its twin `NonRegexRuleSet` has an `isRegex?: false` (`:24`) that nothing sets or reads, now that it left the `ReplacementRuleSet` union.                                           |
| `BACKGROUND_OUTPUT_HEAD_CHARS`, `…_TAIL_CHARS` (`bashDelivery.ts:25`, `:36`) | 1, 0 each              | #14810 | F     | Exported only for the writer's cut. Finding 3.                                                                                                                                                                         |

Also: `surface.ts` (#14806, B) dropped `RunKeyedMapField`, the type that made
a new run-keyed map on `Surface` a compile error until `pruneSurface` pruned
it (old `surface.ts:319-326`, `:368-374`). `rejected` is still a second map
keyed by run id beside `runs` (`surface.ts:239`, pruned at `:409`). Either
move `rejected` into `RunSurface` (it is not persisted, and neither are a
draft's images), or keep the annotation over the two.

Fact names: #14807 added an eighth spelling of the `${plugin}/${kind}` fact
name (`harness/src/agent/runtime/recipeResult.ts:56`, `:70`) to an open
finding, NC4 (`2026-11-07-design-red-flags-lenses/nonobvious-code.md:311-330`,
owner E). Not a new finding; the site joins NC4's list.

## C. Names and comments (batched)

- `texra/src/agent/templates/agentTemplateRenderer.ts` (#14805, C) renders
  nothing. Its own comment says the template is "edited as YAML data, never
  rendered" (`:14`). It holds a 2-row table and a 10-line function, with one
  production consumer (`controllers/settingsView/settingsAgentCommands.ts:31-33`)
  and its regression test. Rename it `agentTemplates.ts` (or move both into
  the consumer and keep the test on the function).
- `RUN_GRANT_CLI_ACTION` (`texra/src/ui/copy/delegationApproval.ts:36`,
  #14809, A) is a function named like a constant. The JSDoc at `:8-12` is
  left with no declaration under it, now that `RUN_GRANT_ORDER` moved below
  `RUN_GRANT_NOUN`, which carries its own comment at `:13-14`.
  `RUN_GRANT_LABEL` (`:28-32`) is a table whose every row is
  `` `Approve all ${RUN_GRANT_NOUN[k]} in this task` ``: a derivable column,
  which `RUN_GRANT_CLI_ACTION` beside it already writes as a function.
- `harness/src/shared/toolUse.ts:170-179` (#14810, F) writes the delivery's
  budgets as "1,000" and "12,000", which drift silently from
  `bashDelivery.ts:25`, `:36`. Name the constants instead (finding 3).
- `harness/src/tools/toolAvailabilityService.ts:43-44` (#14810, F): the
  miss-cache sentence (finding 7).
- `UsageLogService.ts:111-115`, `:281-282` (#14810, F): false (finding 4).
- New comments using words the AGENTS.md table replaces:
  - `texra/src/controllers/session/openProjectSession.ts:37` ("settled",
    #14799, B);
  - `UsageLogService.ts:309` ("admitted") and `:329` ("producer admission",
    #14810, F).

  Each owner fixes these in the PR that touches the file.

---

## Good modules in this area

- `texra/src/controllers/session/openProjectSession.ts` (#14799). One
  program decides where a window's session lives, and both GUI hosts call it
  (`extension.ts:425`, `desktopProjects.ts:267`). The interface is three
  parameters over the service-or-local choice, the close, the first-run
  recorder and the moved-aside notice.
- `Interactions` (`HostInteractions.ts:200-306`, #14802). A class with four
  mutable fields and a replay loop became a `SubscriptionRef` of the attached
  host and a `Queue.sliding` of notices. `attachInteractions` is an
  `acquireRelease`, and the answerer ends on the host's `None`
  (`effect/requestAnswerer.ts:203-210`).
- The desktop window as one tagged state value
  (`desktop/src/main/desktopWindows.ts:54-63`, #14799), and the surface's
  `Shown` union (`texra/src/shared/session/surface.ts:132-145`, #14806). Each
  replaces three optional fields whose impossible combinations are gone.
- `desktop/src/renderer/editorPane.ts` (#14806). Five staleness counters
  became a `Semaphore` per file, `FiberHandle`s for the open and the
  listing, and a `FiberSet` for folder loads. A newer request interrupts the
  older, so no result is checked after its await (`:144-182`).
- `storedTurn.ts:48-78` (#14801). Four `AssertNever<Exclude<…>>` lines make
  a new llm finish reason or part kind a compile error, and `storedDraft`
  returns a `Result` instead of throwing.
- `sumUsageStats` and `addUsage` (`shared/schemas/usage.ts:95-127`, #14801)
  replaced `RunUsageTotalsSchema` and its field-by-field sum. One usage
  shape is summed one way.
- `CredentialOriginSchema` (`llm/src/providers/credentials.ts:51-62`) with
  `ui/copy/credentials.ts` (#14801). One literal set, worded once, read by 9
  files.
- `slashCommands(contributions)` (`cli/src/chat/tui/commands/slashRegistry.ts:119-…`,
  #14802). A registry object became a value, and duplicates are wiring
  errors thrown at construction.

## Already settled, left alone

- **`LaunchKeys` as a fiber `Context.Reference`**
  (`agent/runtime/executeAgent.ts:242-252`, #14801). It is an implicit input
  every fork inherits; #14801 itself caught one leak (the wake), and
  `wakeIfOwed` now provides `{}` (`ToolUseFollowUp.ts:150-156`). The
  remaining gap, a woken run resuming without its own keys, is PT1's,
  already assigned to E (round-3 plan §4.1), and the comment names the
  follow-up.
- **`RUN_GRANT_ORDER` and the policy order read off a record's key order**
  (`delegationApproval.ts:23-25`). This is the round-3 plan's chosen design
  (§2.1, design B). The key order of non-integer string keys is specified.
- **`withPerKeyLane` elsewhere.** `EFF-ADOPT-per-key-lane-semaphore` holds
  wherever claim order or `refuseClaim` matters (finding 8 is the one-key
  exception).
- **`notices.state._tag === 'Done'` as the closed-session test**
  (`HostInteractions.ts:246`, `:273`). `state` is a documented public field
  of `Queue` (`effect/dist/Queue.d.ts:1154`, `:1204`), and the shutdown in
  the finalizer is what sets it.
- **The editor pane's `Effect.cachedInvalidateWithTTL` for Monaco**
  (`editorPane.ts:398-425`). An interrupted load is not cached
  (`effect/dist/internal/effect.js:2022`, "Interruption is abandonment, so
  it is never cached"), so a newer open that interrupts an older one cannot
  poison the load.
- **The usage log's request timeout inside `Effect.uninterruptible`**
  (`UsageLogService.ts:436-437`). The timeout still ends a stalled send,
  because the race forks its children interruptible
  (`effect.js:1179`, `forkUnsafe(…, false)` at `:2455-2458`).
- **`retryBatch` and the warn-once flags in the usage log.** V-R12 kept them
  as real facts (`2026-11-07-design-red-flags-round-3/V-compromises.md:202`).
- **`joinOpening`'s `Effect.ignore`** (`agent/runtime/resumeRun.ts:184-187`,
  #14801). It now ignores only the opening's own failure, which its launch
  reports; a failed read warns first. This is R23's fix.
- **The CLI's Ctrl-C confirmation as a sleeping fiber in a `FiberHandle`**
  (`cli/src/chat/tui/sessionExitController.ts:116-118`, `:263-282`). It is
  read through `Clock` and the chat scope, replaces a `Date.now()` deadline,
  and is testable with `TestClock`. Defensible.
- **The desktop projects as an `RcMap`.** Refuted as
  `RT-desktop-projects-rcmap` (#14799's message).
