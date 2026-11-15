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
