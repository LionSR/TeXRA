Read at `cb22acd`. Covered: `packages/harness/src/agent/` (`core/`, `runtime/` with `loop/`, `run/`, `delegation/`, `modelAccess/`, `historyQuery/`; `index/`, `storage/`, `followUp/`, `prompt/`, `memory/`, `trace/`, `codeSandbox/`, `workspaceAgents/`, `export/`, `debug/`).

# HA: harness agent runtime (area audit)

### HA-1: Whether a plugin agent's plugin loads is decided twice, and a resume resolves its agent twice

- **Package:** harness
- **Flags:** repetition (a rule with two owners); temporal decomposition
- **Evidence:**
  - `packages/harness/src/agent/runtime/resumeBlocker.ts:56-63` takes the plugin name with
    `name.slice(0, name.indexOf(':'))`, tests `load.loadable.some(({ record }) => record.name === plugin)`
    and reads `load.withheld.some((held) => held.plugin === plugin)` to pick `pluginUntrusted` or `pluginOff`.
  - `packages/harness/src/agent/index/pluginAgents.ts:123-138` (`requirePluginAgentLoads`) does the same three
    steps (`entry.name.slice(0, entry.name.indexOf(':'))`, `load.loadable.some(...)`,
    `load.withheld.find((held) => held.plugin === plugin)?.reason`) and words its own message.
  - A resume runs both, one after the other: `resumeRun.ts:248` calls `resumeBlocker(config)`
    (catalog `forLaunch` + `readInstalledPluginLoad`), then `resumeRun.ts:261` calls
    `prepareAgentDefinition`, whose `AgentLaunchContext.ts:63-78` runs `forLaunch` and
    `readInstalledPluginLoad` + `requirePluginAgentLoads` again. Two catalog resolutions and two
    reads of the install records for one decision; a plugin turned off between the two reads fails the
    resume as a plain `Error` (`refusalFor` rethrows it, `resumeRun.ts:111`) instead of the `blocked`
    refusal the first check exists to give.
  - "This agent is inline" is also read two ways: `config.agentSource === 'inline'`
    (`resumeBlocker.ts:38`) and `fullConfig.persona != null` (`AgentLaunchContext.ts:64`).
  - Consumers: `resumeBlocker` 1 production caller (`resumeRun.ts:248`), 0 tests by name;
    `requirePluginAgentLoads` 1 production caller (`AgentLaunchContext.ts:75`).
  - Not recorded: `Y-added-today.md:393` cites `resumeBlocker.ts:39-41` only for the
    `LaunchRefused` translation, which has since landed (`AgentNotFound`).
- **Better design:** `prepareAgentDefinition` is the one resolution of "the agent this config runs,
  here, now". It fails with one tagged error, `AgentUnavailable { blocker: 'agentMissing' | 'pluginOff' | 'pluginUntrusted'; name }`
  (the `ResumeBlocked` payload, which already exists in `@shared/schemas`). `rootRun` and a child's
  launch map it to `LaunchRefused` with the wording `describeResumeRefusal` already has;
  `openResume` maps it to `{ failed: { kind: 'blocked', ... } }`. The plugin-of-name split and the
  loadable/withheld test live once, in `pluginAgents.ts`.
- **Deleted:** `resumeBlocker.ts` (65 lines), the second `forLaunch` and second
  `readInstalledPluginLoad` on every resume, `requirePluginAgentLoads`' separate message, one of the
  two "inline" tests.
- **Size:** about 120 lines, 5 files (`resumeBlocker.ts`, `resumeRun.ts`, `AgentLaunchContext.ts`,
  `pluginAgents.ts`, `rootLaunch.ts` or its refusal mapping).
- **Risk / owner decision:** none for the merge. The message a fresh launch shows for an off or
  untrusted plugin changes to the resume's wording (user-visible text): owner's call which sentence stays.

### HA-2: A resume refusal has two wordings; the one keyed by `kind` drops what the refusal carries

- **Package:** harness
- **Flags:** repetition (one wording, two owners); information lost at an interface (a typed
  refusal narrowed to its `kind` by the caller); silent degradation of a message
- **Evidence:**
  - `packages/harness/src/agent/followUp/ToolUseFollowUp.ts:70-89`: `FAILURE_MESSAGES` is a
    `Record<FollowUpFailureReason, string>` keyed by `ResumeRefusal['kind']`, read through
    `describeFollowUpFailure(kind)`. Its `blocked` entry is the generic "This task's agent, or the
    plugin it comes from, is missing, off or not trusted", and `pluginUnavailable` is "This run needs
    a plugin that is not loaded here", though the refusal names the plugin
    (`shared/schemas/followUp.ts:197-224`: `blocked` has `blocker` and `name`, `pluginUnavailable`
    has `plugin` and `cause`, `earlierBuild` has `cause`).
  - `packages/harness/src/agent/runtime/resumeRun.ts:66-76`: `describeResumeRefusal(reason)` is the
    second wording, which does name the agent or plugin for `blocked` and falls back to the table
    for the rest. One production caller: `effect/sessionPrograms.ts:244`.
  - Two callers hold the whole refusal and pass only its kind, so their text loses the name:
    `ToolUseFollowUp.ts:144` (`wakeRun`'s warning) and `runtime/leftoverChildren.ts:94`
    (the report a parent's model reads about a child that could not resume). PR #14953 changes
    `leftoverChildren.ts` and keeps the `.kind` call (its line 91).
  - A third caller words no sentence at all: `leftoverChildren.ts:84` passes `rejection.kind` itself as the
    `why` of `reportInterrupted` (`:53`), so a parent's model reads "it could not be resumed
    (unusableCheckpoint)" or "(earlierBuild)", a camel-case literal, in the delivery it acts on.
  - Consumers of `describeFollowUpFailure`: 5 production call sites in 3 files
    (`ToolUseFollowUp.ts:144,220,244`, `leftoverChildren.ts:94`, `resumeRun.ts:67`); tests: 0 by name
    (`Q-public-surface.md:652` records only its former `host.ts` export, since removed).
- **Better design:** one function owns the sentence for a refusal, takes the refusal, and lives
  with the type's other readers in `followUp/`: `describeRefusal(refusal: ResumeRefusal | { kind: 'readFailed' } | { kind: 'notParent' })`,
  a `switch` on `kind` that reads `name`, `plugin` and `cause` where the case has them. Every
  caller passes the value it already holds.
- **Deleted:** `describeResumeRefusal` (or `describeFollowUpFailure`: one of the two), the generic
  `blocked` sentence, the `FollowUpFailureReason` string union (the argument is the refusal), the
  three `.kind` narrowings at call sites.
- **Size:** about 60 lines, 5 files.
- **Risk / owner decision:** none; a parent's model and the log gain the plugin or agent name they
  lacked.

### HA-3: "Does this model take this medium, and what is sent instead" is decided at three sites with three answers, and predicted at a fourth

- **Package:** harness
- **Flags:** repetition (a rule with several owners); special and general code mixed (the opening
  message is a special path beside the general one); conjoined methods; non-obvious code
- **Evidence:**
  - Opening message, from file paths: `packages/harness/src/agent/runtime/run/mediaInput.ts:107-154`
    (`partsForFile`). PDF by extension: native document, else page images, else skipped with
    "the model does not accept documents"; audio; image; anything else fails the read. Called from
    `loop/runLoop.ts:211-218` only, which inlines base64 parts that `appendRow` then turns into
    addresses (`providerMessages.ts:310-320`).
  - Follow-up message, from stored bytes: `mediaInput.ts:240-261` (`storedMediaPart`, PDF by mime
    type, null when the model cannot take it) plus the fallback written at its caller,
    `runtime/FollowUps.ts:139-155`: a PDF for a vision model is rasterized
    (`storedPdfPages`), everything else is "the model does not accept it" (no medium named).
  - Tool-result attachment, from stored bytes: `loop/toolUseDispatch.ts:235-237` calls the same
    `storedMediaPart` and has no PDF fallback: a PDF a tool attaches for a vision model without
    native PDF is "the model takes no application/pdf inline", though the same file attached to a
    message is sent as its pages.
  - A fourth site predicts the rule to decide who logs the first user message:
    `runtime/executeAgent.ts:183-190` (`supportsMediaInMessage = supportsVision || supportsNativeAudio`,
    `initialMediaMayBeInserted`) logs it there when no media "may be inserted", otherwise hands
    the text down as `LaunchEntry.initialUserMessage` (`run/AgentRun.ts:88`) for
    `loop/runLoop.ts:219-223` to log with the attachment kinds. The prediction is not the rule
    (a native-audio model with only images attached is predicted to insert media).
  - `attachedMedia` (`mediaInput.ts:206`) asks the rule a fifth way, with a fake digest and an
    all-true capability set: `storedMediaPart(mimeType, '', ANY_MODEL)`.
  - Consumers: `mediaInputParts` 1 production caller; `storedMediaPart` 3 (`FollowUps.ts:139`,
    `toolUseDispatch.ts:235`, `mediaInput.ts:206`); `storedPdfPages` 1; `initialUserMessage` read
    once (`runLoop.ts:219`). Not in the catalogue (`initialUserMessage` appears only in
    `round-5-tests/5-scaffolding.md:202` as a test-fixture field).
- **Better design:** the opening message is the general path's first batch. A launch's
  `mediaFiles` are read once with `attachedMedia` (stored by address, as a follow-up's are) and the
  message is built by the one function that turns `StoredMedia` plus the bound model's capabilities
  into parts: native part, page images for a PDF on a vision model, or a text part naming the
  medium. That function is what `FollowUps.batchMessage`, the opening and `resultContent` call. The
  first user message is logged where it is built, with the kinds that function returned.
- **Deleted:** `partsForFile`, `mediaInputParts`, `MediaInputParts`, the fallback branch in
  `FollowUps.ts:144-155`, `ANY_MODEL` and the fake-digest call (a `mediumOf(mimeType)` answers
  "is this a medium at all"), `LaunchEntry.initialUserMessage`, `supportsMediaInMessage` and
  `initialMediaMayBeInserted` in `executeAgent.ts`, one of the two `logUserMessage` sites.
- **Size:** about 200 lines, 6 files (`mediaInput.ts`, `FollowUps.ts`, `runLoop.ts`,
  `toolUseDispatch.ts`, `executeAgent.ts`, `AgentRun.ts`).
- **Risk / owner decision:** **owner decision** on one behavior: whether a tool-result PDF is
  rasterized for a vision model without native PDF (today it is only mentioned). An unsupported
  opening file would be refused at launch by `attachedMedia`'s rule instead of failing in the
  opening batch; same outcome, earlier.

### HA-4: An awaited child's progress travels as a callback threaded through nine signatures, restating facts the child's rows already hold

- **Package:** harness
- **Flags:** pass-through variable; repetition (a fact with two channels); information leakage (the loop and a
  tool know a delegating caller may be listening)
- **Evidence:**
  - The consumer is one closure, `AgentTool.ts:403-406` (`notify`: `describeSubagentProgress` then
    `call.emit`). It is threaded down by hand: `agentChild.ts:150,171` (`recovery.notify`),
    `childLaunch.ts:194` (`AwaitedChildLaunch.notify`), `:225` and `:238` (`{ onProgress: launch.notify }`),
    `:74` and `:96` (`Pick<ExecuteAgentOptions, 'onProgress' ...>`), `resumeRun.ts:57,268`,
    `executeAgent.ts:71` (`ExecuteAgentOptions.onProgress`) and `:314` (`callbacks: { onProgress }`),
    `run/AgentRun.ts:105-108` (`RunCallbacks`, one optional member, carried on every run's `AgentRun`).
  - The producers restate row facts: `loop/runLoop.ts:181` and `:251` fire `started` right after the opening
    batch commits; `:478-483` fires `overview` from `state.toolCalls`, `state.edited` and `state.usage.cost`,
    all `RunState` read off the rows the line above appended; `tools/plan/PlanTool.ts:235,289` fire `plan`
    beside the plan request the same call opens as rows (`requestApproval`, `:294`).
  - The child already publishes those rows to the session log in the same process, and the parent's wait
    already holds the child's opening commit (`childLaunch.ts:143`, `yield* start` answers it) and its
    `drained` (`:146`). `SessionLogShape.tail(fromCommit)` (`shared/session/sessionLog.ts:107-110`) is the
    stream of display rows from a commit on.
  - A run nobody awaits (every root, every detached child, every resume through `session.resume`) carries
    `callbacks: { onProgress: undefined }`; three test layers build `callbacks: {}`
    (`src/test-kernel/support/nativeToolTestLayer.ts:111`, `scriptedRunLayers.ts:326`,
    `agent/RunScopedToolOverlay.vitest.ts:98`).
  - Recorded only in passing: round 2 `M-harness-tools.md:282` names the callback bag as context for a goal
    finding; no row in the catalogue. Open PR #14953 changes `AgentTool.ts` and `subagentRun.ts` and keeps the
    callback (it moves the line formatter into `printSubagentProgress`).
- **Better design:** the awaited call reads its child's progress from the child's rows: `childRunEnd` forks
  `log.tail(activation)` filtered to the child's `runId` while it waits on `drained`, and maps the rows it
  cares about (the opening's `turn.ready`, each completed turn's usage row, a plan request) to the same card
  lines. The loop and the plan tool stop knowing that anyone listens; progress is one more reader of rows,
  as every other surface is.
- **Deleted:** `RunCallbacks` and `AgentRun.callbacks`, `ExecuteAgentOptions.onProgress`,
  `AwaitedChildLaunch.notify`, `recovery.notify`, the `onProgress` picks in `startChildRun`,
  `resumeOwnedChild` and `ResumeRunOptions`, the five `onProgress?.(...)` sites (three in `runLoop.ts`, two in
  `PlanTool.ts`), the `SubagentProgressUpdate` wire type (`shared/schemas/subagentProgress.ts`, 35 lines) or
  its export, and the three test fixtures' `callbacks: {}`.
- **Size:** about 120 lines removed, 40 added, 12 files.
- **Risk / owner decision:** none in behavior if the tail maps the same three facts. The `started` line moves
  from "opening committed" to "opening row read", the same instant in one process. Sequence after #14953.

### HA-5: `getRunRecords` is four one-field selectors over one row read, so a caller that needs two fields reads the run two to six times

- **Package:** harness
- **Flags:** shallow module; temporal decomposition (one decision spread over sequential reads of the same
  rows); repetition
- **Evidence:**
  - `agent/storage/runOwnership.ts:230-260`: `facts = SessionLog.use((log) => log.facts(runId))`, and
    `exists`, `readRunRecord`, `readConfig` and `readReport` are each `read((held) => held?.x ?? null)` over a
    fresh `facts` (a database read per call, `controllers/session/sessionStore.ts:187-188`
    `database.readRunRecord`). `readRunEnd` and `readResult` read `facts` again inside `whole`.
  - `openResume` (`runtime/resumeRun.ts:213-271`) reads the same run's `RunRows` six times:
    `Effect.all([store.readConfig(), store.exists()])` (`:225`, two reads), `checkpointRefusal`
    (`storage/resumability.ts:35`), `owningCall` (`runOwnership.ts:114-115` via `parentEdge`, `:74`),
    `persistedParentRunId` (`:68`, `parentEdge` again), and `log.facts(runId)` once more for `takesFollowUps`
    (`resumeRun.ts:254`). `exists` and `config` answer the same question (`config === null` already holds for
    a run the database reads as closed, `runOwnership.ts:257`).
  - The same shape elsewhere: `delegation/agentChild.ts:114-115` reads `log.facts(runId)` and then
    `readRunEnd()`, which reads it again; `storage/childRunOutput.ts:33-39` reads `readRunEnd()`,
    `readConfig()` and then `log.facts(...)` directly for the parent edge (three reads);
    `delegation/AgentTool.ts:259,264` reads `readReport()` then `readConfig()`;
    `runtime/ToolServices.ts:174-175` offers a plugin `exists` and `end` as two reads.
  - Consumers (production, `packages/*/src`): `exists` 6, `readConfig` 5, `readRunRecord` 4, `readReport` 3,
    `readRunEnd` 5, `readResult` 1, `readWorkspaceFiles` 1, `readSkills` 1 (through `effect/sessionReads.ts`);
    tests reach them only through `session.records(runId)`.
  - Recorded nearby, not this: round 3 `Q-public-surface.md:661-673` counts the five mirrors of the public
    `RunRecords` read (service protocol); round 1 `L-lifecycle.md:13` lists `persistedParentRunId` among six
    spellings of "the child's parent". Neither names the internal selectors or the repeated reads.
- **Better design:** an internal caller reads `log.facts(runId)` once and selects from the `RunRows` it holds
  (`rows.config`, `rows.report`, `rows.parent`, `rows.start?.takesFollowUps`); `agentConfigOf(rows)` keeps the
  one narrowing `readConfig` adds (`isAgentRunRecord`). The derived reads take the rows they need:
  `runEndOf(rows)`, `deriveResumability(rows)`, `owningCall(edge)`. `openResume` reads once at its top and
  decides from that value; the live checks that must be re-read after it (`inbox.read(...).inputClosed`,
  `runs.stopAsked`) stay where they are. `getRunRecords` remains only as the public `Session.records`
  implementation in `effect/sessionReads.ts`.
- **Deleted:** `exists`, `readRunRecord`, `readConfig`, `readReport` from the internal facade (their
  `sessionReads.ts` public members stay, written as selectors there), `parentEdge` as a separate read, about
  five redundant reads per resume and one or two per child call.
- **Size:** about 120 lines, 12 files (`runOwnership.ts`, `resumeRun.ts`, `resumability.ts`, `agentChild.ts`,
  `childRunOutput.ts`, `AgentTool.ts`, `ToolServices.ts`, `runLifecycle.ts`, `leftoverChildren.ts`,
  `forkRun.ts`, `tools/ExecutionsTool.ts`, `tools/codemode/SelfTool.ts`).
- **Risk / owner decision:** none. Open PR #14944 changes `storage/runLifecycle.ts`; rebase over it. Lands
  with or after HA-1, which removes `resumeBlocker`'s own reads from the same function.

### HA-6: "Can the helper model serve, else use the run's model" is written twice, and "is this option available" has a third spelling (D7 remainder)

- **Package:** harness
- **Flags:** repetition (one rule, two owners); hand-written version of a predicate the schema module owns
- **Evidence:**
  - `runtime/helperModelName.ts:77-84` (`applyHelperModelPreference`): `readModelOptions(stores, [helperModel])`,
    `option?.unavailableReason`, a `logWarning` "Keeping <run model> … helper model … is unavailable", return
    the run's config.
  - `runtime/helperModel.ts:46-60` (`servableHelper`, added by #14924 two days ago): the same read, the same
    test, a second `logWarning` "Using <run model> for a helper call: helper model … is unavailable", return the
    run's model. Its comment says it logs "as `applyHelperModelPreference` logs its own".
  - Both sit after `getHelperModelName` (`helperModelName.ts:25-41`), which has already applied a first
    fallback (a disabled choice becomes the catalog default) with its own spelling of "this ref, without its
    effort" (`modelRefOf(configured) ?? configured`, `:38`).
  - "Is this option available" is read two ways in the slice: by `unavailableReason`'s presence (the two sites
    above) and by `MODEL_AVAILABILITY_STATUS[availability].available` (`delegation/delegationAvailability.ts:41-45`,
    `availableModelNames`), beside the exported predicate that owns it, `isModelOptionAvailable`
    (`shared/schemas/modelAvailability.ts:60-67`, used by the CLI and the app: 4 production importers).
  - Consumers: `servableHelper` 1 (`helperModel.ts:104`); `applyHelperModelPreference` 1 (`rootLaunch.ts:143`);
    `availableModelNames` 2 (same file). Recorded: catalogue D7 (`landed`, #14801) says
    "`applyHelperModelPreference` keeps the one availability read it has" (`D-model-call.md:544-560`); #14924
    added the second one back.
- **Better design:** one function in `helperModelName.ts`, `helperModelFor(stores, runModel)`: the configured
  helper (or the catalog default), kept while `isModelOptionAvailable` holds for its option, else `runModel`,
  logged once. `helperCall` calls it; `applyHelperModelPreference` calls it and adds only its own rule (the
  agent needs function calling). `availableModelNames` filters with `isModelOptionAvailable`.
- **Deleted:** `servableHelper` and its log line; the second `readModelOptions` + `unavailableReason` block;
  the private availability predicate in `delegationAvailability.ts`.
- **Size:** about 45 lines, 3 files.
- **Risk / owner decision:** none; the log wording of the two warnings becomes one.

### HA-7: The delegation targets are a special prompt section, hand-wired through four files beside the general section mechanism

- **Package:** harness
- **Flags:** special and general code mixed; information leakage (the step, the request recorder, the
  context differ and the stored schema all know one tool's section); repetition (two differs for one kind of
  fact)
- **Evidence:**
  - The general mechanism: a step's context is `sections: Record<name, text>` (`shared/schemas/offeredTools.ts:90-94`),
    built by `stepInstructions` from the tool-call text, the skills list and each plugin's `prompt` section
    (`prompt/PromptBuilder.ts:60-90`); at the freeze they are joined into the system text, and after it
    `contextUpdate` re-sends a section whose text changed and withdraws one that left (`PromptBuilder.ts:96-104`).
  - The special one: `PromptSections.delegation` is a typed field of the same stored blob (`offeredTools.ts:93`,
    `DelegationTargetsSchema` at `:73-85`). It is read by the step beside the sections
    (`loop/step.ts:446-459`, `readDelegationTargets`), rendered at the freeze by its own renderer, appended after
    the sections by hand (`run/recordedRequest.ts:177-179`, `delegationSection`), and diffed after it by its own
    differ, called from the general one by name (`PromptBuilder.ts:114-115` → `delegation/delegationAvailability.ts:189-211`
    `delegationUpdate`, with `namesChange` at `:169-182`).
  - So "the agents, models and worktree switch the model is told about" has a renderer, a differ, a stored field
    and three call sites outside its owner, where every plugin's section has none: a plugin's section is one
    `prompt(ctx)` function and the general differ.
  - Why it is special today: a plugin's `prompt` is synchronous over `PromptSection`'s context
    (`tools/toolTable.ts:96`), and the targets need an effectful read (the catalog, `readModelOptions`); and the
    differ words a change line by line ("Agents now available: X") rather than re-sending the list.
  - Introduced by #14896 (round 2's findings 1 to 5); not in the catalogue or a proposal (lens-2 `L2-3.2`
    renamed `PromptSections` only).
- **Better design:** the targets are one more section, `sections.delegation = delegationSection(targets)`, read
  where the step builds the others; the general differ re-sends it when its text changes. If the line-level
  wording is worth keeping, the general differ does it for every section (a section's lines added and removed
  since it was told), so the skills list and a plugin's section get it too. The stored `PromptSections` loses the
  typed field.
- **Deleted:** `PromptSections.delegation` and `DelegationTargetsSchema` (or its stored use), the hand-appended
  render in `systemTextAt`, `delegationUpdate` and `namesChange` (about 45 lines), the `if (now.delegation)`
  branch in `contextUpdate`.
- **Size:** about 90 lines, 5 files (`offeredTools.ts`, `step.ts`, `recordedRequest.ts`, `PromptBuilder.ts`,
  `delegationAvailability.ts`).
- **Risk / owner decision:** **owner decision**: what the model reads when its delegation targets change mid-run
  (the whole section again, or a line diff for every section). A stored context blob from before the change
  decodes without the field (the struct ignores it) and the next step sends the delegation section once as new.
  Open PR #14953 changes `recordedRequest.ts`; rebase over it.

### HA-8: Small items of one species: a fact or a knob placed away from its owner, or with no reader

- **Package:** harness
- **Flags:** shallow module; repetition; an export with no consumer; an option for a special case; a comment
  that is false
- **Evidence:**
  1. `agent/core/definition/` is one 28-line file, `RunRecord.ts`: a `typeof RunRecordFieldsSchema.Type` alias
     and `isAgentRunRecord`, away from the schema they read (`shared/schemas/runRecords.ts:14-25`). Its README
     row (`agent/core/README.md`) says `definition/` holds `AgentConfig`, which moved to `@shared/schemas`
     (names lens, `names.md:515`, landed). The `./schemas` entry re-exports the alias from `agent/`
     (`packages/harness/src/schemas.ts:31`). 8 importing files.
  2. A run's description is cut to 80 characters by two owners: `delegation/childRun.ts:8-10` (a 10-line module,
     `childRunDescription`, 2 callers: `processRun.ts:186`, `tools/codemode/backgroundScript.ts:104`) and
     `sessionDescription.ts:32,50` (`MAX_DESCRIPTION_LENGTH`). The row both feed is built in one place,
     `descriptionRow` / `registrationDrafts` (`shared/session/runFacts.ts:252-260,294-295`).
  3. `SESSION_CLOSE_DEADLINE_MS` is declared in the event-plane module (`runtime/sessionEventsLayer.ts:46-52`),
     which never reads it; its readers are the session owners (`controllers/session/sessionOwners.ts:95`,
     `sessionLayer.ts:218`) and three app and CLI waits through `@texra-ai/harness/plugins` (`plugins.ts:168`).
  4. `ChildRunsShape.parent` (`runtime/ToolServices.ts:93`, served at `:168-172`) has no caller in any
     package or test; it is part of the published plugin door (`config/api-reports/harness.plugins.api.md:27`).
     It is also a third spelling of "a run's parent" (`log.runRows(id, 'input').parent`, beside
     `log.facts(id).parent` in `storage/runOwnership.ts:74-76`).
  5. `CodeSandbox`'s `cpuBudgetMs?` (`codeSandbox/codeSandbox.ts:137-138,212`) is passed only by a test
     (`packages/harness/test/agent/CodeSandbox.vitest.ts:147`); production always runs `GUEST_CPU_BUDGET_MS`.
  6. A child's wall time is stored as display text (`ChildRunDelivery.wallTime`, "as it reads (`1.2s`)",
     `shared/schemas/followUp.ts:92-93`), so each producer formats it: `runtime/childDelivery.ts:89`,
     `delegation/bashDelivery.ts:116` and the app's `tools/agentCli/agentCliShared.ts:255`, each
     `` `${(ms / 1000).toFixed(1)}s` ``. Not among the open items of
     `proposed/simplification/2026-11-14-tool-card-result-and-delivery-shapes.md` §3.
- **Better design:** (1) the alias and predicate live in `runRecords.ts` beside the schema; `definition/` and its
  README row go. (2) `registrationDrafts` and `descriptionRow` cut the description to one
  `RUN_DESCRIPTION_MAX`; `childRun.ts` goes and `sessionDescription` keeps only its word-count rule. (3) the
  constant moves to `sessionOwners.ts`. (4) drop `parent` from the door. (5) the test drives the budget through
  a script that exhausts the fixed one, or the option stays test-only by name; the request field goes. (6) the
  delivery stores `wallTimeMs`, and `formatDelivery` and `deliverySummary` format it once.
- **Deleted:** one directory and one file (`core/definition/`), `childRun.ts`, one duplicated constant, one
  door member, one request option, three copies of the wall-time format.
- **Size:** about 60 lines, 12 files.
- **Risk / owner decision:** item 4 removes a member of the published `@texra-ai/harness/plugins` surface
  and item 6 changes the stored `followup.queued` delivery (a row version bump): **owner decision** on both;
  item 6 belongs with that note's §3 union if the owner takes it. The rest none.

## Good modules here

- `runtime/deliveryEnvelope.ts` (`formatDelivery`): one renderer for every child family's envelope, results and
  errors alike, over a typed payload; the drivers pass facts, never XML (the `lines` escape hatch aside).
- `followUp/FollowUpReader.ts`: a reader that holds no copy of the rows, one wake latch, and the read points
  (`request` / `turn` / `idle`) as data; `needsWake` states the whole wake rule in one function.
- `storage/resumability.ts` (`deriveResumability`): the one answer to "can this run resume", every caller
  asks it (its inputs are what HA-5 would pass in instead of re-reading).
- `runtime/AgentLaunchContext.ts` (`prepareAgentDefinition`): everything a launch can be refused for is
  decided before a run is registered, so no refused launch leaves a FAILED run.
- `codeSandbox/protocol.ts` + `limits.ts`: the worker wire is schemas decoded once at each side, and the
  limits module holds numbers only so the worker bundle stays free of the WASM bytes.
- `runtime/historyQuery/childSource.ts`: a separate process for the model's SQL, chosen because
  `node:sqlite` has no interrupt; the comment states the reason and the read-only guards.

## Considered and left alone

- `ChildRunDelivery` as a union on family and outcome: recorded with its open questions in
  `.agents/docs/proposed/simplification/2026-11-14-tool-card-result-and-delivery-shapes.md` §3; only the wall-time
  item (HA-8.6) is new.
- The helper call as a special request in the general bind: catalogue D7, landed (#14801); HA-6 is the
  availability read that came back after it.
- `ToolPolicy.stopAfterCycle` read at several sites: round 1 E4 / A-child-runs item 8, found.
- `AgentTrace.ts` and `TraceEmitter.ts` naming a nonexistent `helpers.ts`: LC-1a items 1-3 of this audit.
- Exports with no importer in this slice (`runRegistry.ts` `Launch`, `Inbox.ts` `Sent`, `runLifecycle.ts`
  `deliveryId`): LS-1a of this audit.
- `AgentDirectoryService` (`index/AgentDirectoryService.ts`): reviewed in rounds 2, 3, 4 and 7 and in TC2 of
  this audit; nothing new beyond them.
- `WorkspaceAgentsController<Entry>`'s type parameter: two real instantiations (`AgentEntry` in
  `agentCatalog.ts:377`, `SettingsAgentCatalogEntry` in the app's settings controller), so not speculative.
- `SESSION_CLOSE_DEADLINE_MS` spent by five sequential waits (sessions, the session map, the bridge, GitHub
  deliveries, the CLI shutdown step) although its comment promises one budget per process: a real question,
  but its sites are the hosts' and EX-1 (the extension's three closes at deactivation) owns the shutdown
  order; only the constant's misplaced home is reported (HA-8.3).
- `decideExecutable`'s two defaulted parameters (`runtime/requests.ts:107-119`): one caller passes them, one
  does not; a default over a value the caller holds is not an option for a special case.
- `runStatus` in `historyQuery/views.ts:256-260`: a projection of the view into the query store's vocabulary,
  documented in `HISTORY_VIEW_SUMMARY`; not a second owner of a run's status.
- `delegation/childRun.ts`'s 80-character cut beside the session description's: kept in HA-8.2 rather than as
  a finding of its own.

## Summary

| Id   | Title | Package | Flags | Size | Owner decision? |
| ---- | ----- | ------- | ----- | ---- | --------------- |
| HA-1 | Whether a plugin agent's plugin loads is decided twice, and a resume resolves its agent twice | harness | repetition; temporal decomposition | ~120 lines, 5 files | Yes (which refusal sentence a fresh launch shows) |
| HA-2 | A resume refusal has two wordings; the one keyed by `kind` drops what the refusal carries | harness | repetition; information lost at an interface; silent degradation of a message | ~60 lines, 5 files | No |
| HA-3 | "Does this model take this medium" is decided at three sites with three answers, and predicted at a fourth | harness | repetition; special and general mixed; conjoined methods; non-obvious code | ~200 lines, 6 files | Yes (rasterize a tool-result PDF for a vision model) |
| HA-4 | An awaited child's progress is a callback threaded through nine signatures, restating row facts | harness | pass-through variable; repetition; information leakage | ~160 lines, 12 files | No |
| HA-5 | `getRunRecords` is four one-field selectors over one row read; a resume reads the run six times | harness | shallow module; temporal decomposition; repetition | ~120 lines, 12 files | No |
| HA-6 | "Can the helper model serve, else the run's model" written twice; a third availability predicate (D7 remainder) | harness | repetition; hand-written version of an owned predicate | ~45 lines, 3 files | No |
| HA-7 | The delegation targets are a special prompt section wired through four files beside the general one | harness | special and general mixed; information leakage; repetition | ~90 lines, 5 files | Yes (what the model reads when targets change) |
| HA-8 | Small items: a fact or knob away from its owner, or with no reader (six items) | harness | shallow module; repetition; export with no consumer; option for a special case; false comment | ~60 lines, 12 files | Yes for items 4 and 6 (plugin SDK member; stored delivery field) |
