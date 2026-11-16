# HR: harness runtime (design red-flag audit, 2026-11-15)

Read at `main` `d70ad92` (the brief's commit; later commits add only the brief
and the audit reports). Scope: `packages/harness/src/agent/runtime/`,
`agent/codeSandbox/`, `agent/core/`, `agent/followUp/`, `agent/prompt/`,
`agent/trace/`, `model/`.

## Numbers

| Directory                     | Lines (`.ts`) |  Files |
| ----------------------------- | ------------: | -----: |
| `agent/runtime/` (top only)   |          8748 |     38 |
| `agent/runtime/loop/`         |          3388 |      9 |
| `agent/runtime/delegation/`   |          2388 |      9 |
| `agent/runtime/run/`          |          2460 |     11 |
| `agent/runtime/historyQuery/` |           996 |      3 |
| `agent/runtime/modelAccess/`  |           802 |      5 |
| `agent/codeSandbox/`          |          1027 |      5 |
| `agent/core/`                 |           769 |      5 |
| `agent/followUp/`             |           868 |      4 |
| `agent/prompt/`               |           705 |      3 |
| `agent/trace/`                |           616 |      3 |
| `model/`                      |          1200 |      5 |
| **All**                       |     **23967** | **98** |

The five largest files: `agent/runtime/loop/toolUseDispatch.ts` (1011),
`agent/runtime/runRegistry.ts` (887), `agent/runtime/ModelInvoker.ts` (846),
`model/computeModelOptions.ts` (563), `agent/runtime/delegation/AgentTool.ts`
(561).

Open PR touching the area: #14953 (branch `claude/optimistic-cori-q0n270`)
edits `followUp/Inbox.ts`, `HostInteractions.ts`, `childRunBudget.ts`,
`delegation/AgentTool.ts`, `delegation/inputFields.ts`,
`delegation/subagentRun.ts`, `leftoverChildren.ts`, `loop/hooks.ts`,
`run/recordedRequest.ts`.

## HR-1: "can this agent run here now" is decided twice, and a resume decides it twice in a row

- flags: repetition, information leakage, special-general mixed
- package: harness (`agent/runtime/`, `agent/index/pluginAgents.ts`, `shared/schemas/followUp.ts`)
- kind: refactor
- size: S
- earlier: none (round 4 `Y-added-today.md:393` cited `resumeBlocker.ts:39-41` for a `catchTag` into `undefined`; the duplication was not reported)
- open PR: none

**Evidence.** A launch resolves the agent and checks its plugin in
`prepareAgentDefinition` (`agent/runtime/AgentLaunchContext.ts:63-78`): the
catalog's `forLaunch`, then `requirePluginAgentLoads(entry, yield*
readInstalledPluginLoad(roots))`. A resume first calls `resumeBlocker`
(`agent/runtime/resumeRun.ts:248`), which does the same two reads
(`agent/runtime/resumeBlocker.ts:42-58`: `forLaunch(config.agent,
config.agentSource)`, `readInstalledPluginLoad(roots)`), and then, eleven
lines later, calls `prepareAgentDefinition` (`resumeRun.ts:261`), which does
both again. Every resume of a catalog agent pays two catalog lookups, and a
plugin agent two install-record reads.

The plugin of a plugin agent is parsed out of its name by hand at both
sites: `name.slice(0, name.indexOf(':'))` (`resumeBlocker.ts:56`,
`agent/index/pluginAgents.ts:127`), the inverse of the format written at
`pluginAgents.ts:99` (`` `${plugin}:${...}` ``); `agentName`
(`shared/schemas/agent.ts:61-69`) owns the other half of that format. The
verdict is worded twice: the launch's `Agent ${entry.name} does not run: …
plugin ${plugin} is not installed or not enabled.` (`pluginAgents.ts:128-137`)
and the resume's `describeResumeRefusal` (`resumeRun.ts:66-76`). The
`blocker` literals (`shared/schemas/followUp.ts:198`) are read only by that
wording switch (grep `agentMissing|pluginOff|pluginUntrusted` in
`packages/*/src`: `resumeBlocker.ts`, `resumeRun.ts:69-73`, the schema).

Consumers: `requirePluginAgentLoads` 1 production caller
(`AgentLaunchContext.ts:75`), `resumeBlocker` 1 (`resumeRun.ts:248`), no test
imports either.

**The design decision behind it.** "Does this agent resolve, and does its
plugin load as it is now, and if not, why" is one question. The launch path
answers it by failing; the resume path wants a typed "blocked" answer so it
can refuse without failing the run, and grew a second resolver to get one.

**The better design.** `prepareAgentDefinition` fails with one tagged error
for an agent that cannot run here (`AgentUnavailable { blocker, name,
message }`, the `ResumeBlocked` facts plus the one wording), produced by one
`pluginAgentLoad(entry, load)` beside the name format in `pluginAgents.ts`
(which also owns the `plugin:name` split). The launch maps it to
`LaunchRefused` where it does today; `openResume` catches that tag around
its one `prepareAgentDefinition` call and refuses with `{ failed: blocked }`.
Deleted: `resumeBlocker.ts` (65 lines), `requirePluginAgentLoads`, the second
`indexOf(':')` parse, and one of the two wordings. Callers write one call.

**What we give up, and risk.** The resume's checks reorder: the blocker is
then checked after `persistedParentRunId` and `stopAsked`
(`resumeRun.ts:252-258`) instead of before; both outcomes refuse the resume,
so only which refusal a person sees in that race changes. The resume's
"catalog misses a plugin agent, read the install record" branch
(`resumeBlocker.ts:47-55`) must move into the shared check, since the launch
today reports such a miss as plain "not found".

**How I tried to refute it.** Looked for a reason the resume must decide
before `prepareAgentDefinition` (a side effect in between): the lines between
are reads (`persistedParentRunId`, `facts`, `stopAsked`). Checked that
`prepareAgentDefinition` treats an inline persona as `resumeBlocker` does
(both skip the catalog: `AgentLaunchContext.ts:64`, `resumeBlocker.ts:39`).
Grepped the evidence folders and `refuted-candidates.json` for
`resumeBlocker`, `requirePluginAgentLoads` and `pluginUntrusted`: no
earlier report.

## HR-2: the runtime's module maps and file-level comments describe modules that are gone

- flags: comment restates code, vague name
- package: harness (`agent/runtime/README.md`, `agent/core/README.md`, `packages/harness/AGENTS.md`, five source headers)
- kind: docs
- size: S
- earlier: IC6/IC7 (lens `interface-comments.md:141`) fixed one README line (`finalizeRun`); this is the rest, written since by the renames of #14896 and later
- open PR: none

**Evidence.** `agent/runtime/README.md` names, as modules of this
directory, eight that no file or symbol in the repo carries (grep `-w` over
`packages/harness/src`, every hit is the README itself):
`runLaunchGuard` (`README.md:29`), `endActivation` (`:36`), `childRunLoop`
(`:62`), `childTurnResult` (`:63`), `nativeSubagentStrategy` (`:66`), the
`run/` module `invocation` "(the one model-call retry loop)" (`:17`; the
loop is `ModelInvoker.ts`), and `toolUse` as the loop's file (`:10`; it is
`loop/runLoop.ts`). It files `RunCell` under `runProgram` (`:11`; `RunCell`
is `shared/session/runHistory.ts`), and lists `storedTurn`, `RunHistory`,
`SessionEvents` and `sessionServices` as top-level modules here (`:50-56`;
they are `shared/schemas/storedTurn.ts`, `makeRunHistory.ts`,
`shared/session/sessionEvents.ts`, and an Effect in `ToolServices.ts:126`).
Its closing paragraph (`:72-75`) says a native child "keeps one run scope
and live handle across follow-ups" and that "its concurrency permit is
released while the child waits for input"; `packages/harness/AGENTS.md:47`
says every child "runs one cycle", `resumeRun.ts:261-264` forces
`stopAfterCycle` for any run with a parent, and the permit wraps the whole
flow (`executeAgent.ts:350-355`, `budget.withPermits(1)(flow)`). Modules the
map does not mention: `makeRunHistory`, `sessionEventsLayer`,
`SessionHandle`, `processRun`, `leftoverChildren`, `providerMessages`.

`agent/core/README.md` puts `AgentConfig` in `definition/`; that directory
holds only `RunRecord.ts` (28 lines), and `AgentConfig` is
`shared/schemas/agentConfig.ts:143`. `packages/harness/AGENTS.md:46` repeats
the path.

In source:

- `loop/runProgram.ts:1-7`: "What the loop does between them stays in
  `toolUse.ts`" (no such file) and "the loop writes its own three-argument
  `Effect.acquireUseRelease`"; `:137-141` calls `settleRun` "the release step
  of the run's acquireUseRelease". The loop uses `Effect.onExit`
  (`loop/runLoop.ts:520-521`); there is no `acquireUseRelease` in
  `runLoop.ts`.
- `trace/AgentTrace.ts:8,64` and `trace/TraceEmitter.ts:6` send the reader to
  `helpers.ts` for the app-specific helpers; the file is `trace/traceLogs.ts`.
- `delegation/bashDelivery.ts:28` mirrors "the foreground
  `checkToolResultTextLimit`", which does not exist anywhere in
  `packages/*/src`.
- `AgentTrace.openRun(kind)` (`trace/AgentTrace.ts:22,92`) opens a streaming
  message, while `openRun(runId, resume)` (`loop/runProgram.ts:79`) opens a
  run's cell; one name for two things in the same subsystem. The stream
  opener has 2 callers (`ModelInvoker.ts`).
- The loop's span names still say `toolUse.*`
  (`loop/runLoop.ts:108,148,255,294`) for a file and function named
  `runLoop`/`runToolUse`.

**The design decision behind it.** The README is a hand-kept index of a
flat directory; nothing checks a bare module name (`gate:docs` checks only
cited paths), so each rename leaves it behind.

**The better design.** Rewrite the module map from the directory as it is,
naming each entry as a path so `npm run gate:docs` checks it from then on
(the gate already resolves cited repo paths). Fix the five source headers in
the same commit; rename `AgentTrace.openRun` to `openStream` (its handle is
already `StreamHandle`).

**What we give up, and risk.** None; `openStream` touches the SDK's
`AgentTrace` interface (`packages/harness/docs/api/` regenerates).

**How I tried to refute it.** Grepped each name across `packages/*/src`,
`src/` and the docs (`-w`) before listing it; kept only names with no
definition anywhere. Checked that `executeAgent.ts` holds the permit around
the whole flow and that a child cannot wait for input
(`resumeRun.ts:261-264`, `AgentLaunchContext.ts:105-106`).

## HR-3: a refused message or resume is worded by two functions keyed differently, and a withdrawn sender rule is still threaded through three interfaces

- flags: overexposure, repetition, special-general mixed, information leakage
- package: harness (`agent/followUp/`, `agent/runtime/resumeRun.ts`, `agent/runtime/leftoverChildren.ts`; the SDK's `plugins` entry)
- kind: refactor
- size: S
- earlier: none for the wording; `fromParent` is the remainder of a withdrawal `.agents/docs/implemented/architecture/2026-10-24-peer-runs.md:148` recorded (#14896)
- open PR: #14953 touches `Inbox.ts` and `leftoverChildren.ts` (log helpers only); it leaves all of this

**Evidence.** _A dead option._ `RunInboxSendOptions.fromParent`
(`agent/followUp/ToolUseFollowUp.ts:50-53`) is extended by
`SubmitFollowUpOptions` (`:55`), destructured and passed on (`:185`, `:233`),
becomes `SendOptions.fromParent` (`agent/followUp/Inbox.ts:83-88`) and is
checked at `Inbox.ts:289-290`, which returns the refusal reason `notParent`
(`Inbox.ts:79`), worded at `ToolUseFollowUp.ts:80-81` and documented at
`:33`. No caller passes it: grep `fromParent` over `packages/*/src`, `src/`
and `packages/*/test` finds only those lines. The three producers of
`submitFollowUp` pass `{}` (`tools/executions/send.ts:78-86`), `{ hold,
attach, apiKeys }` (`controllers/session/SessionRequests.ts:351-359`) and
`options ?? {}` from `RunInbox.send` (`ToolUseFollowUp.ts:279`), whose one
caller passes none (`packages/texra/src/tools/github/subscriptionsLayer.ts:145`).
The peer-runs note says the admission "drops its 'non-parent sender' refusal
(`SendOptions.fromParent`, one sender today)"; today there are none.
`RunInboxSendOptions` is on the SDK's public surface
(`packages/harness/docs/api/plugins.md:1698-1703`).

_Two wordings of one refusal._ A `ResumeRefusal`
(`shared/schemas/followUp.ts:216-227`) is worded by `describeResumeRefusal`
(`agent/runtime/resumeRun.ts:66-76`), which reads a blocked refusal's
fields, and by `describeFollowUpFailure` (`ToolUseFollowUp.ts:70-89`), a
table keyed on `kind` alone. The same `answer.failed` is passed to the
first by `session.resume` (`effect/sessionPrograms.ts:244`) and to the
second by the follow-up wake (`ToolUseFollowUp.ts:144`) and by the leftover
children's report (`leftoverChildren.ts:91`). So a blocked resume reads
"This task's agent, ${name}, is not installed…" (`resumeRun.ts:70`) on one path and "This
task's agent, or the plugin it comes from, is missing, off or not trusted"
(`ToolUseFollowUp.ts:82-83`) on the other, and the fields the schema carries
for the person are dropped by the kind-keyed table on every path:
`pluginUnavailable.plugin` and `.cause` (`followUp.ts:221-225`) become "This
run needs a plugin that is not loaded here." with no plugin named
(`ToolUseFollowUp.ts:76`), and `earlierBuild.cause` (`:220`) is never shown.
grep `describeFollowUpFailure|describeResumeRefusal`: 5 call sites, the two
definitions.

**The design decision behind it.** Each refusal path grew its own
sentence; the follow-up table took the resume kinds by `kind` so the
message path and the resume path could share it, and in doing so dropped
the payload. The sender rule was withdrawn in the design and left in the
code because nothing failed.

**The better design.** One `describeRefusal(reason: ResumeRefusal |
{ kind: 'readFailed' })` beside `ResumeRefusalSchema`, a `switch` over the
union that reads each case's fields (the plugin's name, the earlier build's
cause, the blocked agent), used by all five call sites; `describeResumeRefusal`
and `FAILURE_MESSAGES` go (one wording each, 2 functions deleted). Delete
`fromParent` from `RunInboxSendOptions`, `SubmitFollowUpOptions` and
`SendOptions`, the `notParent` reason and its sentence; `RunInbox.send`
loses its `options` parameter, and `RunInboxSendOptions` (public, 1
consumer: itself) is deleted. A plugin writes `inbox.send(item)` as it
already does.

**What we give up, and risk.** `RunInboxSendOptions` leaves the SDK surface
at 0.x (`npm run docgen` regenerates the reference). The leftover-children
path's choice to say nothing for a blocked child (`leftoverChildren.ts:89-92`)
stays its own decision, not a wording.

**How I tried to refute it.** Searched every package, the repo-root suites
and `packages/*/test` for a producer of `fromParent: true` or a test
pinning `notParent`: none. Checked `git log -S"fromParent"`: introduced by
#14896 with the peer-runs note already calling it withdrawn. Checked that
`describeFollowUpFailure`'s other reason, `readFailed`, is the message
path's own (`ToolUseFollowUp.ts:207-214`) and fits the union above.

## HR-4: the trace's log methods take any data with any message type; the pairing is checked only when the transcript reads the row back

- flags: non-obvious code, information leakage, repetition
- package: harness (`agent/trace/AgentTrace.ts`, `agent/trace/TraceEmitter.ts`, `agent/trace/traceLogs.ts`, `shared/schemas/logPayload.ts`); touches texra (`tools/agentCli/codex.ts`, `tools/agentCli/claudeAgent.ts`, `tools/documents/documentTools.ts`)
- kind: refactor
- size: S
- earlier: none (round 6 `S-stage-area.md` removed `LogOptions.stageId`; the `data`/`messageType` pairing was not reported)
- open PR: none

**Evidence.** A producer writes a categorized row as
`trace.info(message, { messageType, data })` with `LogOptions` =
`{ data?: unknown; messageType?: MessageType }` (`agent/trace/AgentTrace.ts:55-60`);
`TraceEmitter.emitLog` stores `toJsonValue(data)` beside the type unchecked
(`agent/trace/TraceEmitter.ts:104-115`). Which payload goes with which type is
declared once, on the read side: `LOG_PAYLOAD_SCHEMAS`
(`shared/schemas/logPayload.ts:28-45`), applied when the transcript builds
the row (`shared/session/transcriptLogRows.ts:66-78`), where a mismatch
becomes a visible "Malformed <type> payload" error row. So the compiler
accepts any pairing, and a wrong one is found by a person reading a broken
transcript. Producers that hand-build the payload: `codex.ts:123-126`
(`WEB_SEARCH`, `{ query }`), `documentTools.ts:164` and `:216-219`
(`FILE_LIST`), `ModelInvoker.ts:737-739` (`PROGRESS_STATUS`, whose schema is
`Schema.Undefined`, so passing any data there would break the row),
`claudeAgent.ts:156` and `codex.ts:218` (`USER_MESSAGE`), plus the five
helpers of `traceLogs.ts` (`:84`, `:111`, `:160`, `:178`), each of which
restates its type's payload shape in its own parameter list
(`logUserMessage`'s `{ attachments, media, scriptSummary }`, `:141-163`,
against `UserMessagePayloadSchema`). One message type has no producer at
all: `MESSAGE_TYPES.SCRATCHPAD` (`shared/schemas/log.ts:16`) is emitted
nowhere in `packages/*/src` (no `openRun(MESSAGE_TYPES.SCRATCHPAD)`, no
`messageType: MESSAGE_TYPES.SCRATCHPAD`), yet is handled at
`shared/schemas/logPayload.ts:30`, `shared/session/transcriptLogRows.ts:25,84`,
`shared/transcript/transcriptRow.ts:80,288,323`,
`shared/transcript/projectTranscriptRow.ts:227`,
`transcript/completedRunArchive.ts:113` and
`packages/cli/src/chat/tui/render/transcriptRowLines.ts:98`.

**The design decision behind it.** The trace began as a logger with a
free-form `data` bag; categories were added as a string beside it, and their
contract was written where rows are decoded, the only place that had to be
safe.

**The better design.** Type the write with the table that already exists:
`LogOptions` becomes the discriminated union `{ [K in MessageType]: {
messageType: K; data?: (typeof LOG_PAYLOAD_SCHEMAS)[K]['Encoded'] } }`
(plus the bare `{}` for a default row), exported from `logPayload.ts`, so
`codex.ts`'s `{ query }` and every helper are checked where they are
written. The read-side decode stays (stored rows are a boundary). Delete
`SCRATCHPAD` with its six consumer branches and its transcript row kind
(a stored row of that type from an earlier build then decodes as the
`DEFAULT` row; check `rowVersions.ts` for whether that is a version bump).

**What we give up, and risk.** `AgentTrace` is SDK surface (`plugins.md`);
an embedder that logs a free-form `data` with a category gets a compile
error, which is the point. Nothing is lost at runtime.

**How I tried to refute it.** Looked for a write-time check of the pairing
(`runEventDraft`, the session log's publish): none, the only decode is
`transcriptLogRows.ts:66`. Grepped every package for a `SCRATCHPAD` producer,
including `openRun(` (2 callers, both in `ModelInvoker.ts:258-259`, thinking
and response) and the texra plugins: none.

## HR-5: whether a run ends after one cycle, and whether a later turn reaches it, is re-derived at eight sites with three formulas

- flags: special-general mixed, information leakage, non-obvious code
- package: harness (`agent/runtime/`, `agent/followUp/ToolUseFollowUp.ts`, `tools/plan/PlanTool.ts`)
- kind: refactor
- size: M
- earlier: E1/`oneShot` (landed #14774 as the read `noLaterTurn`) and the 2026-11-03 options note §4 (which kept `resume.stopAfterCycle` for the host's resume, `.agents/docs/proposed/simplification/2026-11-03-fewer-processing-options.md:281`); the child sites and the read-back below are what remain
- open PR: none

**Evidence.** _The launch input._ `prepareAgentDefinition` takes
`stopAfterCycle?: boolean` (`agent/runtime/AgentLaunchContext.ts:56-57`) and
ORs in a script (`:105-106`). Every child launch passes the constant `true`:
the detached child (`delegation/subagentRun.ts:140-143`), the awaited child
(`delegation/childLaunch.ts:215-220`) and the owned child's resume
(`childLaunch.ts:99-104`); the general resume derives the same fact again
from the parent edge (`resumeRun.ts:261-264`: `options.stopAfterCycle ||
parentRunId !== undefined || !takesInput`). The design says it once: "Every
child is a run that ends" (`packages/harness/AGENTS.md:47`).

_The stored fact, written from the flag and read back into it._
`executeAgent` writes `run.start.takesFollowUps` as `!stopAfterCycle ||
parentRunId !== undefined` (`executeAgent.ts:98-102`); the resume reads it
back (`resumeRun.ts:251-254`) only to turn it into `stopAfterCycle` again
(`:264`). The message path reads the same fact from the view instead
(`agent/followUp/ToolUseFollowUp.ts:200`), and its comment says the choice
is unresolved: "a run the view has not loaded skips this check … which of
the two is meant is open" (`:195-199`).

_"Does a later turn reach this run", two formulas._ `noLaterTurn`
(`agent/runtime/RunCall.ts:245-249`: `stopAfterCycle && (parent === null ||
awaited)`, 4 production readers: `bash.ts:303`, `ScriptTool.ts:165`,
`AgentTool.ts:354`, `packages/texra/src/tools/agentCli/agentCliShared.ts:175`)
and `PlanTool`'s own (`tools/plan/PlanTool.ts:104-108`: `stopAfterCycle ||
config.script != null`). They disagree on a background child: `noLaterTurn`
says a delivery reaches its later turn (so `bash` may run in the background
there), while `PlanTool` refuses a goal in it as "not a conversation".

**The design decision behind it.** `stopAfterCycle` was a launch knob
before children became runs that end; when they did, each child site set
it, and each later reader recomputed "takes input" and "has a later turn"
from it and whatever edge it held.

**The better design.** `executeAgent` decides `stopAfterCycle` once, from
facts it already holds: a parent edge or a script ends after the cycle; a
root ends after it unless its launch is interactive (`rootRun`'s
`launch.interactive`) or, on resume, its stored `takesFollowUps` says it
takes input. `prepareAgentDefinition` loses the option (4 call-site
arguments deleted, and `resumeRun.ts:263-264` becomes the host's
`interactive` alone, which the 2026-11-03 note kept). `PlanTool` asks
`noLaterTurn` plus its own script test, so "a later turn" has one formula.
The message path's view-or-store choice is the owner's call; read it from
`SessionLog.facts` as the resume does, or say in the comment why the view is
meant.

**What we give up, and risk.** A launch can no longer ask a child to stay
open; nothing asks today. If the view-versus-store question is decided for
the store, a message to an ended one-shot root that a later resume would
read (the comment cites `example/10-external-plugin.ts`) is refused; that
needs the owner (it is a behavior change).

**How I tried to refute it.** Grepped every `stopAfterCycle` (16 production
sites) for a child launch that passes `false` or omits it: none. Checked that
the background child's `takesFollowUps` is `true` (`executeAgent.ts:101`,
a parent edge) while `PlanTool` refuses it, and that `noLaterTurn`'s comment
(`RunCall.ts:239-243`) names the background child as one a delivery
reaches. Read the 2026-11-06 compromises note §6
(`.agents/docs/proposed/architecture/2026-11-06-root-designs-pr1-compromises.md:70-77`):
it settled `noLaterTurn` as a read, not the launch input or `PlanTool`.

## HR-6: the opening's echo of the user's instruction is decided in two places, and a task or fork launched with media never echoes it

- flags: conjoined methods, temporal decomposition, non-obvious code
- package: harness (`agent/runtime/executeAgent.ts`, `agent/runtime/loop/runLoop.ts`, `agent/runtime/run/AgentRun.ts`)
- kind: bug
- size: S
- earlier: none (round-5 tests `5-scaffolding.md:202-205` named `initialUserMessage` only as a test-fixture field)
- open PR: none

**Evidence.** `executeAgent` decides, before the model binds, whether the
launch's media "may be inserted": `config.mediaFiles.length > 0 &&
(supportsVision || supportsNativeAudio)` of the definition's
`modelConfig` (`agent/runtime/executeAgent.ts:183-187`). If not, it echoes
the instruction at once (`:189-190`, `logUserMessage`). If so, it leaves the
echo to the loop by stashing the text on the launch entry
(`:220-225`, `initialUserMessage`; field at `run/AgentRun.ts:68-69,88`),
and `openToolUse` echoes it after reading the media, with their kinds
(`loop/runLoop.ts:220-224`). But `openToolUse` returns before that line on
two of its three fresh-run paths: a fork-seeded child (`runLoop.ts:171-183`)
and a script run (`:188-196`, a background script or a task's recipe). So a
document task launched with `mediaFiles` (the app's `document_task` takes
them, `packages/texra/src/tools/documents/DocumentTaskTool.ts:43,86`) on a
vision model has `initialMediaMayBeInserted` true, is not echoed by
`executeAgent`, and is not echoed by the loop either: its transcript opens
with no user message, while the same task without media, or on a text-only
model, opens with one. A `self()` child seeded from a conversation whose
record lists media (`forkSeed` copies the record, `forkRun.ts:313`) falls
in the same gap. The two halves also read different capabilities: the
launch's flag reads the catalog config (`definition.modelConfig`, from
`selectModel`, `AgentLaunchContext.ts:24-27`), the loop's media read the bound
route's (`bound.config.capabilities`, `runLoop.ts:213-216`).

Read from the code, not reproduced.

**The design decision behind it.** "Echo the instruction" was split by
when the attachment kinds are known: the launch handles the case it can
decide early, and hands the rest to the loop through a field that only one
of the loop's branches reads.

**The better design.** One echo, in `openToolUse`, on every fresh path, as
its first act once it knows what the opening inserts: the media kinds for a
conversation (`media.value.kinds`), none for a seed or a script. Deleted:
`initialMediaMayBeInserted`, `supportsMediaInMessage` and the early
`logUserMessage` in `executeAgent` (`:183-190`), and
`LaunchEntry.initialUserMessage` with its comment. `executeAgent` passes the
display text (`getDisplayedInstruction(config)` for a fresh run) and the loop
writes the row.

**What we give up, and risk.** The early echo happened before the model
bound; the held trace only commits with the opening batch
(`executeAgent.ts:108-130`), so moving it later changes no row order a
reader sees. A launch that fails before its opening commits drops the held
echo either way.

**How I tried to refute it.** Checked whether a script run's recipe echoes
the instruction itself (searched `packages/texra/src/tools/documents/` and
`agent/output/documentRecipe.ts` for `logUserMessage` and `USER_MESSAGE`:
none), and whether a task's config is a script run (`AgentLaunchContext.ts:105-106`
treats `config.script != null` as the task case; `packages/harness/AGENTS.md:63`).
Checked that held trace events reach the opening batch only through
`enter` (`executeAgent.ts:112-130`), so the early echo is not visible earlier.

## HR-7: "is the model Anthropic" is decided twice and published on the plugin contract, where no plugin reads it

- flags: overexposure, special-general mixed, repetition
- package: harness (`agent/prompt/PromptBuilder.ts`, `agent/runtime/loop/step.ts`, `agent/runtime/executeAgent.ts`, `tools/toolTable.ts`)
- kind: refactor
- size: S
- earlier: none
- open PR: none

**Evidence.** The step computes `isAnthropic: model.config.provider ===
ModelProvider.ANTHROPIC` (`agent/runtime/loop/step.ts:455`) and passes it in
the `PromptSection` context (`tools/toolTable.ts:95-104`), the type every
plugin's `prompt` section receives. The only reader is the harness's own
`stepInstructions` (`agent/prompt/PromptBuilder.ts:72`), which picks between
two tool-call boilerplates; the two plugin sections that exist read
`offered`, `isChild` and `config` (`tools/memory/memoryPromptSection.ts:30`,
`packages/texra/src/tools/registry.ts:238,311`); grep `isAnthropic` over
`packages/*/src`: those two lines and the type. The launch computes the same
test again for the template variable `IS_ANTHROPIC_MODEL`
(`executeAgent.ts:199`, `agent/prompt/templateInputs.ts:129,141,173,178`),
from the catalog config rather than the bound one. `PromptSection` is SDK
surface (`@texra-ai/harness/plugins`).

The boilerplate choice is a model behavior read as a provider name: the
comment (`PromptBuilder.ts:35-42`) says the split is "parallel tool calls
handled natively" versus providers that need the sequential guardrails, and
the harness already carries per-model capabilities on the bound model
(`bound.forcedToolChoice`, read at `loop/runLoop.ts:382`).

**The design decision behind it.** Which tool-call instructions a model
gets was written as a provider check where the prompt is built, and the
check rode out on the context type that happened to reach that function.

**The better design.** `stepInstructions` takes the bound model (or the one
capability it needs) as its own argument; `PromptSection`'s context drops
`isAnthropic`, so the plugin contract carries only what plugins read. The
template variable keeps its one computation in `buildTemplateInputs`
(documented for agent authors, `packages/extension/resources/docs/agent-creation/agent_schema.md:43`).
If llm's model config gains a parallel-tool-call capability, both read it
instead of the provider; that is the llm package's call.

**What we give up, and risk.** None at runtime. The SDK's `PromptSection`
narrows at 0.x (`npm run docgen`).

**How I tried to refute it.** Searched the app, the hosts and
`packages/harness/example/` for a plugin prompt section reading
`isAnthropic`: none. Checked that `stepInstructions` has one caller
(`step.ts:452`), so passing the model to it changes one site.

## HR-8: single-caller files and one-step wrappers in the run layer, and a guard over an effect that cannot fail

- flags: shallow module, pass-through, non-obvious code, comment restates code
- package: harness (`agent/runtime/`)
- kind: refactor
- size: S
- earlier: (a) is the remainder of E2 (round 1 `E-loop-tools.md:239-240`, "`commandApproval.ts` folds into `toolGuard.ts` (one caller)"; E2 landed #14769 without it); the rest none
- open PR: none

**Evidence.**

- (a) `loop/commandApproval.ts` (77 lines) exports `askCommandApproval` and
  `commandRejectedResult`, each with one caller, both in
  `loop/toolGuard.ts:183,191`; the file has no other importer.
- (b) `delegation/childRun.ts` (10 lines) is one function,
  `childRunDescription = truncateWithEllipsis(raw, 80)`, with two callers
  (`processRun.ts:195`, `tools/codemode/backgroundScript.ts:104`). The bound
  of a `run.description` is restated as `MAX_DESCRIPTION_LENGTH = 80`
  (`sessionDescription.ts:31`, `:50`), and the user's rename writes the row
  with no bound (`controllers/session/SessionRequests.ts:141-146`). The row
  has one constructor, `descriptionRow` (`shared/session/runFacts.ts:252-261`),
  which `registrationDrafts` uses for a child's description (`:294-295`).
- (c) `SessionRunRegistry.stopHeld` (`runRegistry.ts:813-818`) is
  `Effect.asVoid(this.stopping(runId, reason, false))`, one caller
  (`:803`), with a five-line comment restating `stopping`'s.
- (d) `finish` (`loop/runLoop.ts:494-495`) is the identity constructor
  `({ state, outcome }) as const` with a comment ("its halt commits with
  its `run.end`") that describes `endRun`, not the function; 5 callers.
- (e) `joinOpening` (`resumeRun.ts:174-183`) puts `Effect.ignore` on
  `runs.openingOf(runId)`, commented "An opening that failed leaves no run
  here, which reads below as not resumable". `openingOf` is
  `Deferred.await` of a `Deferred<void>` (`runRegistry.ts:404-409`) that is
  only ever completed with `Effect.void` (`:483`), so it cannot fail and the
  `ignore` and its comment describe nothing; a reader looks for a failure
  path that does not exist.
- (f) `loop/runProgram.ts` (169 lines) has one importer, `runLoop.ts:63`,
  which calls `openRun` once (`:156`) and `settleRun` once (`:521`): the
  run's entry and its exit, cut away from the loop between them, with a
  header that names a file and a bracket that are not there (HR-2).

**The design decision behind it.** Each was extracted when its caller was
being rewritten and kept its own file or name after the caller became the
only one.

**The better design.** (a) the two functions move into `toolGuard.ts`, the
file goes. (b) `descriptionRow` bounds its own text, `childRun.ts` and
`MAX_DESCRIPTION_LENGTH`'s copy go, and every writer of the row, the rename
included, gets the same bound (or the rename keeps its own and says why).
(c) `stopUnder` calls `stopping(id, reason, false)`. (d) the five returns
write the record. (e) `joinOpening` awaits the opening without `ignore`, and
the comment says what the read below does. (f) `openRun`, `foreignProtocol`
and `settleRun` move into `runLoop.ts` beside `openToolUse` and
`runToolUse`, which already hold the rest of the run's open and exit.

**What we give up, and risk.** `runLoop.ts` grows to about 680 lines, under
the files around it (`toolUseDispatch.ts` 1011). A user's long title gets
an ellipsis if (b) applies the bound to the rename.

**How I tried to refute it.** Counted importers of each file and callers of
each symbol across `packages/*/src`, `src/` and `packages/*/test` (no test
imports `commandApproval`, `childRun` or `runProgram`). Read how
`Opening.settled` is completed: only `Deferred.doneUnsafe(..., Effect.void)`
(`runRegistry.ts:483`).

## Good modules in this area

- `agent/runtime/runRegistry.ts`: one map of tagged entries (`Pending |
  Opening | Live | Ending | Busy`, `:99-152`) holds every fact about a run in
  this process, and each operation decides and marks in one synchronous
  step (`enter`, `claimStop`, `holdInactive`) before any effect runs. Large
  (887 lines), but the interface (`start`, `stop`, `withInactiveRun`, `get`)
  is small against it.
- `agent/runtime/AgentRunLifecycle.ts` `commitEnd` (`:88-140`): the one end
  both run programs commit, with the close-without-stop and lost-rows rules
  decided once, so `endRun` and `processRun.ts` differ only in their verdict
  and report.
- `model/computeModelOptions.ts`: route once, read each provider's key once,
  word each option purely; the unavailable-reason table is checked against
  `MODEL_AVAILABILITY_STATUS` by its type (`:59-78`).
- `agent/runtime/deliveryEnvelope.ts`: one renderer for every child's
  envelope, its field order fixed by the schema.
- `agent/runtime/historyQuery/`: the model's SQL runs in a child process over
  copied, decoded rows, so no statement reaches the session database.

## Already settled, left alone

- The canned validation route inside `decideRoute`
  (`modelAccess/routeDecision.ts:39-48,94-100`): settled as the CLI-provided
  `ValidationModel` port (`.agents/docs/proposed/architecture/2026-10-27-tech-debt-target-designs.md:371,407`;
  round 3 `R-test-infrastructure.md:704`, R5).
- `ChildRunDelivery` as one struct with optional fields, including its two
  answer fields (`response` and `output.response`, rendered at
  `deliveryEnvelope.ts:58-62,73-75`): held for the owner as a stored-row and
  plugin-contract change (`.agents/docs/proposed/simplification/2026-11-14-tool-card-result-and-delivery-shapes.md` §3).
- `Dispatch.session` and the `sessionServices` pick list beside the
  `SessionServices` union (`loop/toolUseDispatch.ts:139-141`,
  `ToolServices.ts:126-144`, `rootLaunch.ts:44-58`): E5 landed (#14878) and
  kept the captured context for the plugin-facing doors (`childRuns`,
  `callRequests`), whose types must not name session services; the two lists
  are checked against each other by the compiler.
- `noLaterTurn` as a read of `stopAfterCycle` and the parent edge
  (`RunCall.ts:245-249`): settled in
  `.agents/docs/proposed/architecture/2026-11-06-root-designs-pr1-compromises.md:70-77`
  (HR-5 reports only the launch input and `PlanTool`'s second formula).
- `HostInteractions`' optional members (`HostInteractions.ts:45-64`): E8
  landed (#14769, #14802).
- `ITool.describe` with one implementer and `ModelInvoker`'s narrating
  header: IC6, open in the catalogue
  (`../2026-11-07-design-red-flags-lenses/catalogue.md`, "Status at main
  `433d874`").
- The plain-names words still in the area ("settle" in `SettleMessageSchema`,
  `settleRun`, `toolUseDispatch.ts`): NM1/NM9, a rule each owner applies to
  what it touches, not a finding.
