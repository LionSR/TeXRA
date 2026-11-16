# LN: non-obvious code, silent degradation, casts, Promise and timer code, shared mutable state

Read at `d70ad92` (source unchanged at the report's commit). Lens auditor:
the whole repo's `packages/*/src`. Read-only. Earlier coverage of these
flags: `../2026-11-07-design-red-flags-lenses/nonobvious-code.md` (N),
`../2026-11-07-design-red-flags-round-7-fallbacks/REPORT.md` (FB),
`../2026-11-14-concurrency-primitives/` with
`.agents/docs/proposed/architecture/2026-11-14-nothing-held-across-a-wait.md`
(the concurrency rows), and review-checklist §15. Only what those did not
report, or what regressed, is below.

## Numbers

Sampled with grep over `packages/*/src` (tests excluded), then read in full
where a hit could hide a failure.

| Shape                                                                                                           | Count at `d70ad92`                                                      | Against the earlier counts                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| bare `catch {`                                                                                                  | 20 (cli 6, desktop 5, harness 6, llm 1, texra 2)                        | FB: 22. Every one carries a reason comment now, including FB10 a and b                                                                        |
| `Effect.ignore` / `ignoreCause` without `{ log }`                                                               | 5                                                                       | the five FB judged (`resumeRun.ts:183`, `mcpServer.ts:251,280`, `leanServer.ts:245`, `chatSessionController.ts:430`)                          |
| `orElseSucceed`                                                                                                 | 5                                                                       | all turn the failure into a value the caller reports (`skillLoader.ts:277`, `promptFilesXml.ts:71`) or are display or provider-boundary reads |
| `catchDecoding`                                                                                                 | 12 (llm 11, cli 1)                                                      | unchanged: provider and JWT boundaries, settled in FB "Good"                                                                                  |
| `catch*` handlers that end in a default with no log, absence check or reported value (heuristic, 8 lines after) | 26, all read                                                            | 24 are deliberate and commented (cancel, interrupt, best-effort typing); none drops a persisted read                                          |
| `as` casts outside `as const`                                                                                   | 74 (harness 36, texra 22, cli 8, llm 4, extension 3, desktop 1)         | N: 64. Every non-trivial one has a `// cast:` reason in the lines above it                                                                    |
| module-level `let`                                                                                              | 37                                                                      | each one already found or settled (K, M7, EX-4, TC-6, X S3, the refused external-roots service)                                               |
| module-level mutable `Map`/`Set`                                                                                | 13 lane maps (row 8, settled) and 6 others                              | see "Already settled"                                                                                                                         |
| `new Promise` / `.then(` outside UI                                                                             | 0 / 2 (`arxivProcessor.ts:395`, `prelude.ts:81` in the sandbox prelude) | both found (I, round 2) or a script template                                                                                                  |
| `setTimeout` / `setInterval` outside UI                                                                         | 2 (`cliState.ts:540`, `usePollingInterval.ts:28`)                       | X S3 keeps the first                                                                                                                          |

The degradation shapes the earlier rounds named are largely gone or
justified at the site. What is left for this lens is where correctness
depends on a fact the reader cannot see from the site: a second writer that
skips the lock the first one takes, a check that reads a value twice, and
state whose meaning is set somewhere else.

Lines read for the lens (`packages/*/src`, `.ts`/`.tsx`, tests excluded):
texra 81,527; harness 79,150; cli 44,932; extension 15,758; desktop 14,491;
llm 12,094; trace-viewer 407. The five largest files the findings change:
`desktop/src/main/desktopWorkspaceIpc.ts` 485,
`harness/src/common/plugins/hookProtocol.ts` 457,
`cli/src/runtime/headless/executeCli.ts` 434,
`texra/src/latex/acceptedFileTarget.ts` 371,
`harness/src/common/plugins/pluginHooks.ts` 360.

A thin lens this round: four findings. The earlier lens (NC1 to NC-B) and
round 7 (FB1 to FB10) landed, and spot checks of their sites hold
(`traceAssembler.ts:59` ends in `absurd`, `structuredOutput.ts` keeps no
`captured`, `step.ts:295-304` names a withdrawn skill it leaves out,
`SubscriptionOAuthCoordinator.signOut` warns on an unreadable session,
`desktop/src/main/index.ts:139-146` passes the failed reach on so the window
says it). What survives is where two writers, or a writer and its reader,
are kept apart by a fact neither site shows.

---

## LN-1: Accepting a document task's output writes the user's file with its own staged rename, outside the file's write lane, and breaks a symlinked target

- flags: non-obvious code, repetition, special-general mixed
- package: texra (`latex/acceptedFileTarget.ts`); touches harness
  (`tools/approval/approvedWrite.ts`, `utils/files/fileWriteLane.ts`)
- kind: bug
- size: S
- earlier: none (round 3 V's R1, "the accept race", is about the user-edit
  diff reading the file again; it landed as `acceptEditedFileReplace`
  returning what it wrote. It did not look at how the write is done)
- open PR: none

**Evidence.**

- There are two ways a run's output is accepted into a workspace file.
  - The `accept_run_files` tool goes through the harness's one writer:
    `approvedWriteConflict` (`texra/src/tools/AcceptRunFilesTool.ts:344`),
    that is `writeApprovedContent`
    (`harness/src/tools/approval/approvedWrite.ts:49-97`). It reads, merges
    onto what is there, and writes **in place** with `fs.writeFile`
    (`:93`), all under `withFileWriteLane(file)` (`:95`).
  - The document task toolbar's Accept (both hosts, through
    `ProgressDocumentTaskFileActionsController.acceptFile`,
    `:142-160`) calls `acceptEditedFileReplace`
    (`texra/src/latex/acceptedFileTarget.ts:237-283`). It reads the target
    (`:252`), asks the person, reads it again and compares (`:268`), then
    `commitAcceptedFile` stages a sibling `.<name>.<uuid>.tmp` and
    `fs.rename`s it over the target (`:168-183`).
- **No lane.** `withFileWriteLane` exists so that "every writer that reads a
  file, decides and writes it back" is the file's one writer; "two writers
  on two maps would each pass their check and the later write would replace
  the earlier unseen" (`harness/src/utils/files/fileWriteLane.ts:10-18`). Its
  consumers are the approved edit (`approvedWrite.ts:95`) and the desktop
  editor's save (`desktop/src/main/desktopWorkspaceIpc.ts:376`). The
  toolbar accept is exactly that shape (read at `:268`, decide, write at
  `:173`) and takes no lane: `grep -rn withFileWriteLane packages/*/src`
  has no hit in `texra`. A run's approved `edit_file` on the same `.tex`, or
  a desktop editor save, that lands between the re-check at `:268` and the
  rename at `:173` (the read of the edited file at `:162` sits between them)
  is replaced without a word, which is the loss the "changed while the
  confirmation was open" check at `:265-273` was written to prevent.
- **The rename replaces the directory entry.** `rename(staged, target)`
  over a symlink replaces the link with a regular file, so accepting into a
  `.tex` that is a symlink (a shared preamble, a file linked in from a
  synced folder) cuts the link: the edit lands in the project and the file
  the link pointed to keeps the old text. The staged file is created with
  the default mode, so a target's mode (a read-only `0444` file, a
  group-writable one) is reset. The in-place write of the tool path keeps
  both. The repo's own crash-safe replace, `writeFileAtomic`, "preserves an
  existing target's mode and ownership, and resolves the target's real path
  so a symlinked target is replaced where it points"
  (`harness/src/utils/files/fsDurability.ts:121-138`), and says it is
  "not for workspace files" (`:128`); the accept wrote its own version of
  it for a workspace file anyway, without those two properties.
- `acceptEditedFileReplace` has 1 production caller
  (`ProgressDocumentTaskFileActionsController.ts:152`); `commitAcceptedFile`
  is file-local with 1 caller (`:275`).

**The design decision behind it.** "How is an accepted output written into
the user's file" is answered twice: by the harness's approved-write owner
for the tool, and by a local staged rename for the toolbar. Only the first
knows about the lane.

**The better design.** The toolbar accept writes through the same owner as
the tool. `commitAcceptedFile` calls
`writeApprovedContent(targetPath, confirmedAgainst ?? null, editedContent)`
(a workspace path through `WorkspaceFs`, an external one through the
process `FileSystem`, as `writeApprovedContent` already picks at
`approvedWrite.ts:61-65`). The lane, the in-place write and the "changed
meanwhile" check then come from one place: an `ApprovedEditConflictError`
replaces the hand-written re-read at `:265-273`, and its message is the
"changed while the confirmation was open" notice. Deleted: the staged path,
the rename and its cleanup (`acceptedFileTarget.ts:166-183`, about 18
lines), the second `contentOrMissing` read and its notice (`:265-273`).
`writeApprovedContent` merges onto a concurrent change instead of refusing;
if the toolbar must refuse rather than merge, pass the confirmed content as
`original` and the edited content as the result, which refuses on any
overlapping change, the same rule the tool applies.

The lane is per process, and the toolbar accept runs in the host process
while a service-attached project's runs write from the service: LN-4 moves
both writers into the project's process; LN-1's change is the first half of
that and is right on its own for the symlink and mode defect.

**What we give up, and risk.** The torn-write guarantee of the rename for
this one path: an in-place write interrupted by a crash can leave a partial
file. Every other workspace write (the tool's accept, every `edit_file`,
the desktop editor) already writes in place, so the toolbar would match
them; `nodeFileServices` makes every write uninterruptible
(`fsDurability.ts:86-110`), which covers a stop, not a power cut.

**How I tried to refute it.** Looked for a lane taken by the caller
(`acceptFile`, `ProgressDocumentTaskFileActionsController.ts:142-160`): none.
Looked for a reason the accept must rename (a host that watches renames, a
comment): the only reason given is crash safety (`:166-167`), which the
writer it should share does not give elsewhere either. Checked that the
desktop and VS Code hosts both reach this function, not a host write:
`acceptEditedFileReplace` takes only `confirm` and `showInfo` from the host
(`:152-156`). No open PR touches the file.

## LN-2: A hook's output is cut before it is parsed, and the runner drops the fact that it was cut, so a long JSON answer becomes raw context or no effect with no warning

- flags: non-obvious code, information leakage
- package: harness (`common/plugins/pluginHooks.ts`, `common/plugins/hookProtocol.ts`)
- kind: bug
- size: S
- earlier: none (round 2 M judged `interpretHookRun` good,
  `../2026-11-06-design-red-flags-round-2/M-harness-tools.md:722`; nobody
  read the runner that feeds it)
- open PR: none

**Evidence.**

- The runner keeps "the first `OUTPUT_MAX` characters of each stream"
  (`pluginHooks.ts:306-316`), with `OUTPUT_MAX = 10_000` under the comment
  "The reference's cap on what a hook adds to the model's context"
  (`:242-243`). The cap the comment names is on what reaches the context,
  but it is applied to the raw stdout, before anything parses it.
- `HookRun`'s `exited` case carries `exitCode`, `stdout` and `stderr` only
  (`hookProtocol.ts:164-173`): nothing says the text was cut.
- `interpretHookRun` reads stdout as JSON only when it "starts with `{` and
  ends with `}`" (`hookProtocol.ts:377-390`); anything else is plain text,
  which on `SessionStart` and `UserPromptSubmit` becomes context as it
  stands, `status: 'ok'`, `warning: null` (`:448-456`). So:
  - A `SessionStart` or `UserPromptSubmit` hook that answers with JSON
    longer than 10,000 characters (an `additionalContext` of a project
    summary, say) is cut mid-string, no longer ends with `}`, and its first
    10,000 characters of raw JSON are put into the model's context, with no
    warning.
  - A `PreToolUse` hook whose JSON carries a long `updatedInput` (a
    rewritten file body) or a `deny` with a long reason is cut the same
    way and has no effect: the tool runs with its original input. The
    protocol's own rule is that "malformed output … ha[s] no effect and
    always carr[ies] a warning" (`:350-352`); a cut answer is malformed
    output that carries none, because the reader cannot see the cut.
- The drain wait has the same hole. After the hook exits, the readers get
  `STDIO_GRACE` (250 ms, `:248-250`):
  `Fiber.join(readers).pipe(Effect.timeoutOption(STDIO_GRACE), Effect.ignore({ log: 'Warn', message: "A hook's output could not be read to its end; the result keeps what was read" }))`
  (`:336-343`). `timeoutOption` succeeds with `None` when the time runs out
  (the repo reads it that way at `extension/src/frontend/latex/openBuild.ts:305-307`,
  `harness/src/agent/runtime/historyQuery/HistoryQuery.ts:360-361`), so
  `Effect.ignore` sees a success and the warning is never logged in the
  one case its message describes. It fires only when a reader fails.

**The design decision behind it.** "Was the whole answer read?" is known
only to the runner, which drops it; the interpreter that decides what the
answer means then cannot tell a cut answer from a complete one. The cap is
placed in the runner although it is a rule about context, which the
interpreter owns.

**The better design.** The runner reports what it read, and the
interpreter decides.

- `HookRun.exited` gains `cut: boolean` (one field; `HookRun` has 1
  producer, `pluginHooks.ts`, and 1 reader, `interpretHookRun`, through
  `loop/hooks.ts:172`). The runner sets it when a stream passed its read
  limit or when `timeoutOption` returned `None`
  (`if (Option.isNone(drained)) cut = true`).
- `interpretHookRun` returns `status: 'malformed'` with the warning "its
  output was cut at N characters" for a cut answer, as it does for any
  output it cannot read, instead of treating the prefix as plain context.
- The 10,000-character cap moves to where context is added (the
  `context` the verdict carries), which is where the reference applies it;
  the runner's read limit becomes a memory bound well above it (the pipe
  still drains past it, as today).

**What we give up, and risk.** A hook that prints more than the read limit
as plain text loses its context instead of contributing a prefix; it gets a
warning in place of a silent cut. Nothing persisted changes: `HookRun` is
in-memory.

**How I tried to refute it.** Checked whether a later step re-reads the
full output (no: `out` is the only buffer, `:308`), whether
`interpretHookRun` gets the run's byte count (no: `HookRun` at
`hookProtocol.ts:164-173`), and whether `timeoutOption` could fail on
timeout in this codebase's Effect version (every other caller matches
`Option.isNone` on it). `node_modules` is not installed in this checkout,
so the `Effect.d.ts` signature was not read; the six callers above agree.
No open PR touches either file.

## LN-3 (batched): A deadline whose expiry is the case worth telling is written as `timeoutOption` with the `None` dropped, and one false comment left from FB1

- flags: non-obvious code, comment restates code
- package: cli (`runtime/headless/executeCli.ts`); touches texra
  (`controllers/server/windowHost.ts`) and harness (the LN-2 instance)
- kind: bug (a), docs (b)
- size: S
- earlier: (a) none: F5 (`../2026-11-05-design-red-flags/F-hosts.md:425-452`)
  is the shutdown step's race, settled; this is what the step says when its
  deadline passes. (b) remainder of FB1, landed in #14849: FB1 fixed the
  false doc on `attachWindowHost` (`windowHost.ts:110-117` now says the
  window waits), not the same sentence further down the file.
- open PR: none

**Evidence.**

- The house style for a deadline is `Effect.timeoutOrElse` with an
  `orElse` that fails or logs (`sessionLayer.ts:217-220`,
  `codeSandbox.ts:320-323`, `sessionDescription.ts:168-171`,
  `toolUseDispatch.ts:929`, `commands/service.ts:197-200`), or
  `timeoutOption` followed by a match on `None`
  (`openBuild.ts:305-307`, `HistoryQuery.ts:360-361`,
  `nodePlatform.ts:266-268`). Two sites take `timeoutOption` and keep only
  the failure branch, so the expiry, which `timeoutOption` returns as a
  success, is the one outcome nobody tells:
  - a. **The headless run's shutdown step.** On SIGTERM the step
    interrupts the run and waits for the command's finalization, which
    prints the resume command (`executeCli.ts:301-312`, the hint written by
    `onInterruptedRunFinalized` at `:112-124` and called at `:385-391`). It
    runs under `Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS)` (5 s,
    `harness/src/agent/runtime/sessionEventsLayer.ts:52`) followed by
    `Effect.catchCause(… sayShutdownFailure("The run's shutdown step failed; the exit does not wait for its finalization", …))`
    (`executeCli.ts:323-333`). A run that takes longer than 5 s to unwind
    gives `None`: the exit goes on, the resume command is never printed,
    and stderr says nothing, though the run is resumable at the next
    open. The interactive chat's equivalent wait uses `Effect.timeout` and
    says "the session's rows did not settle within 5000 ms"
    (`chat/tui/runChatTui.tsx:681-691`): two policies for one deadline in
    one package.
  - b. The hook runner's drain (`pluginHooks.ts:336-343`), whose warning
    never fires on the timeout its message describes: LN-2.
- **A false comment left from FB1.** `attachTo`'s end says "The service
  stopped or restarted: the window goes on with its own process's
  capabilities" (`texra/src/controllers/server/windowHost.ts:241-242`).
  The function's own doc says the opposite, as FB1's fix made it: "the
  attachment ends and the window waits: no call reaches it, its session
  refuses with the link's offline reason, and it attaches again"
  (`:113-117`), and the code only logs and lets the next client re-attach
  (`:238-251`, `:160-168`).

**The design decision behind it.** Whether running out of time is worth
telling is decided per site, and `timeoutOption`'s success-on-expiry makes
the wrong answer look like handling.

**The better design.** (a) `Effect.timeoutOrElse({ duration: SESSION_CLOSE_DEADLINE_MS, orElse: () => sayShutdownFailure(…) })`
with a line saying the run did not finish stopping in time and is left
resumable under its run id (which the step holds, `launchRunId`), the
chat's policy, so a signal exit either prints the resume command or says
why it could not. (b) is LN-2's `cut` flag. (c) The
comment at `windowHost.ts:241-242` says what the branch does: the
attachment ended, the window waits for the link's next client. No new
helper: each site uses the primitive the other sites already use.

**What we give up, and risk.** One more stderr line on a slow shutdown,
suppressed under `--quiet` like every `sayShutdownFailure` line
(`executeCli.ts:270-277`).

**How I tried to refute it.** For (a), looked for a later step that
prints the hint after the deadline (none: `finalized` is the only path,
`:281,404`), and for a reason the expiry should be silent in the comment
(the comment, `:324-325`, says only that the deadline bounds SIGTERM). For
(b), read the whole of `attachTo` and `attachWindowHost` for a local
fallback: there is none, and `HostWindows.localLink` serves only a link to
this process. Neither file is in an open PR.

## LN-4: The file write lane that keeps an editor save and an approved edit apart is per process, and a folder's runs write from the service process while the desktop editor saves from the app's

- flags: non-obvious code, comment restates code (a false comment)
- package: desktop (`main/desktopWorkspaceIpc.ts`); touches harness
  (`utils/files/fileWriteLane.ts`, `tools/approval/approvedWrite.ts`) and
  texra (`controllers/session/openProjectSession.ts`, and LN-1's accept)
- kind: bug
- size: M
- earlier: regression of the concurrency note's row 8, recorded as done:
  "An approved edit and the desktop editor's save share one lane per file
  (`withFileWriteLane`)" and "An approved edit and an editor save guard one
  file with two maps. Row 8: one service, one key"
  (`.agents/docs/proposed/architecture/2026-11-14-nothing-held-across-a-wait.md:173-174,255-256`).
  The key is one; the map is one per process, and the two writers are in
  two processes on the main path.
- open PR: none

**Evidence.**

- `withFileWriteLane` is "one process-wide lane per file", a module-level
  `Map` (`harness/src/utils/files/fileWriteLane.ts:10-19`).
- The desktop editor's save holds it in the Electron main process: the
  check against `base` and the write run under
  `withFileWriteLane(absolutePath)` (`desktop/src/main/desktopWorkspaceIpc.ts:360-376`),
  under the comment "The check and the write hold the file's write lane,
  which an agent's approved edit of the same file holds too, so neither
  lands between the other's check and write" (`:351-358`).
- The agent's approved edit takes the lane where the tool runs
  (`approvedWrite.ts:95`). A desktop window with a folder opens its session
  in the background service whenever the service is reached:
  `openProjectSession` returns `where: 'service'` with a `serviceSession`
  (`texra/src/controllers/session/openProjectSession.ts:34-45`), the app
  reaches the service at launch (`desktop/src/main/index.ts:139-146`,
  `desktopService.ts:38-55`), and the service runs the tools itself ("The
  TeXRA service cannot run a window's own tools",
  `texra/src/controllers/server/serviceSession.ts:551-559`). So on macOS and
  Linux, the main configuration, the run's `edit_file`, `write_file` or
  `accept_run_files` takes the lane in the service's process and the
  editor's save takes it in the app's: two maps, and the race the lane was
  written for ("two writers on two maps would each pass their check and the
  later write would replace the earlier unseen", `fileWriteLane.ts:13-15`)
  is open. Only a window that could not reach the service, and Windows
  (`WINDOWS_UNSUPPORTED`, `controllers/server/client.ts:139`), run both in
  one process.
- LN-1's toolbar accept runs in the host process too
  (`ProgressDocumentTaskFileActionsController.ts:152`), so a lane taken there
  would meet the service's approved edits no better.
- The window between check and write is short on each side (a read and a
  write, `desktopWorkspaceIpc.ts:367-374`; a read, merge and write,
  `approvedWrite.ts:66-93`), so the loss is rare, and when it happens the
  later write replaces the earlier with no `changedOnDisk` and no conflict.

**The design decision behind it.** "Who may write this project's files
right now" is answered by a lock that lives in whichever process asks,
while the project's writers were split across processes by the service
work. The fact that the two writers share a process is far from both call
sites and true only when the service is out of reach.

**The better design.** Every read-decide-write of a project file goes
through the process that holds the project's session, which is where the
runs write. The desktop's save and the toolbar accept become requests on
the window's session (`session.request`, which a `serviceSession` already
forwards to the service and a local session serves in process), served by
one handler that holds `withFileWriteLane` and answers `changedOnDisk` or a
conflict, as today. Then the lane's "process-wide" is the project's lane,
whichever host is attached, and the comment at
`desktopWorkspaceIpc.ts:351-358` is true. What goes: the desktop's own
check-and-write (`:360-376`) and LN-1's staged write; the hosts keep their
dialogs. Design it twice: (A) a cross-process lock file per workspace file
is hand-written infrastructure, needs stale-lock recovery, and still
leaves two writers; (B) one writer process per project reuses the
service's existing ownership of the project and its request channel.
Choose B.

**What we give up, and risk.** An editor save becomes a round trip to the
service when one is attached (a local socket, as every run request already
is). A save while the service link is down is refused with the link's
offline reason, as a run request is (`SERVICE_OFFLINE`, `client.ts:506-507,646`), unless the
window falls back to its own process; that choice is FB1's "one policy for
one outage" and should follow it.

**How I tried to refute it.** Looked for a cross-process guard on
workspace writes (a lock file, an `flock`, a compare-and-swap through the
session store): none; `JsonStore` names the same limit for its own files
("across processes the atomic rename is the only guarantee",
`platform/defaults/jsonStore.ts:134-135`). Looked for the desktop save going
through the service: `writeFile` uses the main process's `FileSystem`
directly (`desktopWorkspaceIpc.ts:362-374`). Checked that approved writes
run where the tool runs, not in the window that showed the approval: the
tool awaits the decision and then calls `approvedWriteConflict` in the
same fiber (`texra/src/tools/AcceptRunFilesTool.ts:330-348`). Neither
`desktopWorkspaceIpc.ts` nor `fileWriteLane.ts` is in an open PR.

---

## Good modules for this lens

- **`writeApprovedContent`** (`harness/src/tools/approval/approvedWrite.ts:49-97`):
  read, merge onto what is there, refuse an overlap with a typed error,
  write in place, all under the file's lane. The writer LN-1 and LN-4 route
  the other writers through.
- **`JsonStore`** (`harness/src/platform/defaults/jsonStore.ts`): states its
  cross-process limit in its own doc (`:131-136`) instead of implying a
  guarantee, re-reads on write, and keeps writes failing over an unreadable
  file. The honesty LN-4 asks of the write lane.
- **`interpretHookRun`** (`harness/src/common/plugins/hookProtocol.ts:354-457`):
  one total reading of a hook run with a warning on every no-effect case.
  LN-2 only gives it the one fact it cannot see.
- **The `// cast:` discipline** still holds at 74 casts: every non-trivial
  one says why (`controllers/server/service.ts:237-249`,
  `serviceSession.ts:562-571`, `RunCall.ts:269-276`).
- **`timeoutOrElse` with a said expiry** (`sessionLayer.ts:217-220`,
  `toolUseDispatch.ts:929`, `codeSandbox.ts:320-323`): the pattern LN-3's
  two sites should copy.

## Already settled, left alone

| Instance                                                                                                                                            | Where it is settled                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `extractTarFile`'s `pending?.then(...)` join (`texra/src/latex/arxivProcessor.ts:351-413`)                                                          | round 2 I (`../2026-11-06-design-red-flags-round-2/I-latex-documents.md:609-615`) |
| `TerminalOutput.writeTerminalText`'s 100 ms race (`texra/src/ui/progress/components/TerminalOutput.ts:301-312`)                                     | refused, `UI-terminal-write-without-bound`                                        |
| `transientNoticeTimer` (`cli/src/chat/tui/state/cliState.ts:514-547`)                                                                               | X S3, kept: ~55 synchronous callers hold no runtime                               |
| `pendingExitCode` / `setExitCode` (`cli/src/commands/_helpers/exitCode.ts`)                                                                         | refused, `RT-cli-exit-code-one-function`                                          |
| `externalRoots`' module registry (`harness/src/utils/files/externalRoots.ts:88`)                                                                    | refused, `SCOPE-external-roots-standalone-service`                                |
| the lane maps (`fileSecrets.ts:42`, `jsonStore.ts:90`, `fileWriteLane.ts:19`, `memoryFileSystem.ts:95`, `lakeCommands.ts:30`, `codexConfig.ts:135`) | refused, `M7-file-lanes-as-references`; row 8 "Stays"                             |
| the extension's annotation `let`s (`inlineCriticism.ts:55`, `inlineComments.ts:33,38`)                                                              | EX-4, this round                                                                  |
| `cachedExtraDirs` (`texra/src/platform/defaults/commandDirs.ts:17`)                                                                                 | TC-6, this round                                                                  |
| the CLI's quiet log sinks (`cliService.ts:249-253`, `doctor.ts:60`)                                                                                 | CL-9, this round                                                                  |
| `UsageLogService`'s sliding queue and dropping trigger (`telemetry/UsageLogService.ts:331-335`)                                                     | logs each drop at warn (`:531`); concurrency note row 20                          |
| `HostInteractions`' sliding notice queue (`agent/runtime/HostInteractions.ts:209`)                                                                  | logs each drop at warn (`:243-248`)                                               |
| the remaining `forkDetach` sites (`HostInteractions.ts:94`, `ToolUseFollowUp.ts:161`, `openGuiWindow.ts:281`, `hostRunActions.ts:381`)              | concurrency note "Left, with the reason" (row 14)                                 |
| the display-only and boundary bare `catch {` (20 sites)                                                                                             | FB "Good" and §15 L1/L3; each now carries its reason                              |
| the llm `catchDecoding` defaults (`oauth/xai/*`, `chatgptProvider.ts`, `jwtDecode.ts`)                                                              | FB "Good"; round 2 O                                                              |
| `runOwnership`'s failed usage fold (`agent/storage/runOwnership.ts:173-177`)                                                                        | logs at warn; the run's cost reads as unknown, not zero                           |
