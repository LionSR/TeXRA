# Design red flags by lens, round 2: the flags no earlier audit searched

Read-only. Read on `main` at `00a6890` (the catalogue's status commit). Each
section is one Ousterhout red flag (_A Philosophy of Software Design_) that
either no round-1 to round-7 brief listed or that the 2026-11-07 lens audits
left with a near-zero count. Every item below was read in the source at that
commit; line numbers are exact unless marked `~`. Items already in
`2026-11-07-design-red-flags-lenses/` or in any round folder are not repeated.

Counts were taken with grep and checked by hand. Each section ends with how
common the flag is, so a thin section is a result, not a gap.

| Section | Flag (chapter)                                           | Earlier coverage                                   |
| ------- | -------------------------------------------------------- | -------------------------------------------------- |
| 1       | Comment repeats code (ch. 13)                            | none: the catalogue counts zero                    |
| 2       | Implementation documentation contaminates interface (13) | `interface-comments.md` Findings 6 and 7 (2 items) |
| 3       | Hard to pick name, vague name (ch. 14)                   | `names.md` N1 to N10                               |
| 4       | Pass-through variable (ch. 7)                            | `pass-through.md` Findings 1 to 6                  |
| 5       | Hard to describe (ch. 13)                                | `interface-comments.md` "hard to describe" section |
| 6       | Shallow module (ch. 4)                                   | area briefs only                                   |
| 7       | Information leakage (ch. 5)                              | area briefs only                                   |
| 8       | Consistency (ch. 17)                                     | none                                               |
| 9       | Configuration parameters and knobs (ch. 8)               | `2026-11-03-fewer-processing-options.md`           |

## 1. Comment repeats code

About 1% of the ~10,000 JSDoc blocks outside tests. They cluster in older Lit
components, `@param` blocks, and schema field docs. The ~600 import-group
headers (`// Third-party imports`) are mandated by `AGENTS.md` and are not
counted.

| Where                                                                    | Comment                                                               | Code it repeats                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/texra/src/tools/documents/DocumentTaskTool.ts:111`             | `/** The \`document_task\` tool. */`                                  | `DocumentTaskTool = defineTool({ name: 'document_task'`                         |
| `packages/harness/src/agent/runtime/delegation/AgentTool.ts:543`         | `/** The \`agent\` tool. */`                                          | `agentTool = () =>`                                                             |
| `packages/texra/src/tools/lean/LspTools.ts:73` (also `:84`, `:107`)      | `/** Path to the Lean file */`                                        | the field's own `description: 'Path to the .lean file'`                         |
| `packages/harness/src/shared/schemas/opResults.ts:20,22`                 | `True if the command timed out` / `Exit code from the command`        | `timedOut: Schema.Boolean` / `exitCode: Schema.Int`                             |
| `packages/harness/src/shared/schemas/toolResult.ts:14`                   | `MIME type for the file`                                              | `mimeType: Schema.String`                                                       |
| `packages/harness/src/agent/runtime/helperModel.ts:33,35`                | `User message content.` / `Optional system prompt.`                   | `userPrompt: string` / `systemPrompt?: string`                                  |
| `packages/harness/src/utils/files/externalRoots.ts:63`                   | `Whether writes are permitted.`                                       | `writable: boolean`                                                             |
| `packages/cli/src/runtime/platform/cliContext.ts:151,153`                | `Color is allowed on stdout.`                                         | `stdoutColorEnabled: boolean`                                                   |
| `packages/harness/src/effect/sessions.ts:165`                            | `The latest snapshot.`                                                | `current: () => SessionView`                                                    |
| `packages/texra/src/ui/progress/formatters/timestampUtils.ts:22,27`      | `Get the time-only formatter.`                                        | `getTimeFormatter()`                                                            |
| `packages/texra/src/ui/progress/components/LatexDiffsSection.ts:157-175` | seven: `Base file value`, `Base file options`, …                      | `baseFile`, `baseFileOptions`, … (densest cluster)                              |
| `packages/harness/src/utils/prompt.ts:36-39`                             | `@param files List of file paths` / `@returns Comma-separated string` | the signature; the doc omits that null gives `''` and blank entries are dropped |
| `packages/harness/src/tools/formatting.ts:20`                            | `@param lines - Array of lines to format`                             | `lines: string[]`                                                               |
| `packages/texra/src/latex/TikzPictureManager.ts:25-26,63`                | `@param label Label for the figure`                                   | `label`                                                                         |
| `packages/llm/src/providers/providerPlugins.ts:57`                       | `The provider's own name.`                                            | `displayName: string`                                                           |

Roughly a third of the repo's ~60 `@param` lines restate the parameter name
or type. The fix is deletion, or replacing the line with the unit, the absence
case, or the invariant the signature does not carry.

## 2. Implementation documentation contaminates interface

The six SDK entry files (`index.ts`, `host.ts`, `plugins.ts`, `node.ts`,
`schemas.ts`, `transcriptEntry.ts`) are clean. The contamination is in the
JSDoc of the symbols they re-export, and docgen ships it under
`packages/harness/docs/api/*.md`. "Shipped" below means the text appears
there.

| Where                                                                                  | Symbol (shipped in)                              | What the doc says that a caller does not need                                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/harness/src/shared/schemas/requestPayloads.ts:118-123`                       | `CredentialSwitchSchema` (`schemas.md`)          | "decided once by the retry owner (`ModelInvoker`)": a private symbol in no API doc. Needed: it comes with a failed run's error; render it.                  |
| `packages/harness/src/effect/processLayer.ts:68-77`                                    | `ProcessLayerOptions` (`host.md`)                | names `ownerProcessLayer` and `globalAppStateLayer`, both private, and what the CLI does with `appState`. Needed: each field and its default.               |
| `packages/harness/src/effect/processLayer.ts:57-66`                                    | `ProcessServices` (`host.md`, `plugins.md`)      | names the internal `ToolCatalogOwner` tag only to say the caller cannot have it.                                                                            |
| `packages/harness/src/transcript/traceDocumentSchema.ts:19-21` (+ `schemas.ts:29,204`) | `TraceDocumentSchema` (`schemas.md`)             | "(`assembleTrace`)" three times: which private function writes the four absent facts.                                                                       |
| `packages/harness/src/shared/toolUse.ts:197-201`                                       | `executionsWaitTimeoutSeconds` (`transcript.md`) | a list of who calls it ("the tool's own input schema … both transcript surfaces"). Needed: clamped to [60, 1800] s, default 300.                            |
| `packages/harness/src/shared/state/stateSettings.ts:290-294`                           | `GIT_COMMITS_TO_SHOW_SETTING` (`schemas.md`)     | the whole doc is a map of readers and writers; it never says what the setting means or its default.                                                         |
| `packages/harness/src/shared/schemas/modelAvailability.ts:56-61`                       | `isModelOptionAvailable` (`schemas.md`)          | "Lives with the kind so delegation's model list and the CLI's picker can never drift": where the code lives and two internal readers.                       |
| `packages/harness/src/utils/system/nodeWorkspace.ts:34-40`                             | `relativeToRoot` (`node.md`)                     | the order of internal passes and its two callers, one in the desktop app.                                                                                   |
| `packages/harness/src/utils/system/platformPaths.ts:85-96`                             | `withExtendedPath` (`node.md`)                   | a bug-fix story ("so on Windows the extension silently applied or did not … is the whole fix"). Needed: PATH is written under the key the env already uses. |
| `packages/harness/src/shared/model/subscriptionAuth.ts:14-18`                          | `SUBSCRIPTION_ROUTES` (`schemas.md`)             | "The ids stay as they are: the CLI's commands and the settings views' messages spell them." Needed: the ids are stable.                                     |
| `packages/harness/src/agent/runtime/run/AgentRun.ts:99-101`                            | `ToolPolicy.stopAfterCycle` (`plugins.md`)       | "(`RunCall.ts`)": a source file the package reader cannot open.                                                                                             |
| `packages/harness/src/agent/core/tools/ToolTypes.ts:119-121`                           | `ITool.replay` (`plugins.md`)                    | "(`toolUseDispatch.ts`)": same.                                                                                                                             |
| `packages/texra/src/controllers/modelAccess/subscriptionProviders.ts:1-15`             | module header                                    | history ("Every host used to restate…") and a **false** location: says it lives in `packages/harness/src/controllers/`; the file is in `packages/texra`.    |
| `packages/harness/src/shared/tools/toolInputPreview.ts:43-48`                          | `deriveToolInputPreview` (`transcript.md`)       | "which is what the CLI used to show for every delegation call."                                                                                             |
| `packages/harness/src/agent/workspaceAgents/workspaceAgentsState.ts:48-56`             | `readWorkspaceAgentsSelection`                   | walks through three other functions' locking to explain why this one is pure. Needed: read-only, never repairs.                                             |
| `packages/harness/src/agent/runtime/childRunBudget.ts:3-7`                             | `ChildRunBudget` header                          | "Design and rulings … `.agents/docs/implemented/architecture/2026-08-15-…md`": a design-doc citation Finding 7 does not list.                               |

Smaller "used to" and ruling citations: `transcriptRow.ts:350-354`
(`compactionActivityRow`), `runGeneratedFiles.ts:3-9`,
`cli/src/commands/_helpers/dispatch.ts:555-561`, `cli/src/tui/usePollingInterval.ts:52-54`,
`cli/src/chat/tui/modals/ConfirmCardState.ts:106` ("ruling A9-6"),
`harness/src/shared/config/settings.ts:297` ("by ruling"),
`cli/src/chat/tui/state/formSlot.ts:5-8` ("#12908").

Still present from `interface-comments.md`: Finding 7's `terminalNotifier.ts:13`
and `runProgressRenderer.ts:317` (moved by three lines); Finding 4's
`AppSignals` "Consumed by / Not the CLI" paragraphs (`host.md:455-551`);
Finding 6's `ITool.describe` mention of `step.ts`.

## 3. Hard to pick name, vague name

Fourteen cases `names.md` does not cover. Paths relative to `packages/`.

**One word, several meanings**

- **"process" means four things in the harness.** `effect/processLayer.ts:205`
  (process-wide services); `agent/runtime/processRun.ts:98` `processRun` (a run
  whose turn is an OS process; reads as the verb "process a run"; it runs the
  turn and writes the end rows; `runProcessChild`);
  `texra/src/tools/AcceptRunFilesTool.ts:218` `processFs` (the unconfined
  filesystem; `hostFs`); and the empty verb in
  `agent/runtime/run/img.ts:318` `processPdf2Png` (rasterizes up to 100 pages;
  `rasterizePdfPages`) and `texra/src/ui/progress/formatters/markdownRenderer.ts:13`
  `processMarkdownContent` (renders markdown plus KaTeX; `renderMarkdownHtml`).
- **"context" means three things in the run layer.**
  `shared/schemas/offeredTools.ts:90` `RunContext` is the prompt sections, tool
  names and delegation targets, declared in a file named for tools;
  `offeredTools.ts:103` `ContextBlobSchema` is any stored model-facing blob;
  `agent/runtime/run/requestContext.ts` is "what the model saw, recorded"
  (`RecordedRequestSchema`, `contextAt`). Beside these: the context window and
  Effect's `Context`. Renames: `recordedRequest.ts`, `PromptSections`,
  `systemTextAt`.
- **`Slot` declared twice, unrelated fields.**
  `shared/session/transcriptState.ts:56` (a row's working state: `base`, `text`,
  `running`) and `llm/src/api/parts.ts:88` (a growing content part). Both say
  only "a place for something".
- **`InputPart` derived twice.** `llm/src/api/parts.ts:18` and
  `harness/src/agent/runtime/run/mediaInput.ts:41` derive the same name from
  two sources; the harness should import llm's.

**Pairs hard to tell apart**

- `FailedNext` (`shared/schemas/runHistoryEvent.ts:79`: unchain, retry, ask,
  stop, decline) and `NextAttempt` (`shared/session/inFlight.ts:202`: send,
  observe, reask, await, fail, cancel). Two "what happens next" unions with
  overlapping members, both named from "next". `FailedNext` reads as "failed
  next".
- `routeOrDeny` and `denyAndRoute`
  (`desktop/src/main/desktopNavigationPolicy.ts:21`, `:43`). The first opens
  the URL externally if allowed and otherwise does nothing; nothing is routed
  or denied. Mirror-image conjunctions for one behaviour.
- `fetchAndPlaceSource` and `stageAndPlaceSource`
  (`texra/src/latex/arxivProcessor.ts:554`, `:622`). Both docs open "Download
  the arXiv source … place". The outer one's real job is claiming the paper
  directory and removing it on an unfinished exit; the name does not say so.

**Names that hide a second job or a condition**

- `ensureCorrectXmlStructure` (`texra/src/agent/output/replyDocuments.ts:355`)
  applies the session's XML replacement rules and logs diagnostics, then closes
  an unterminated `<documents>` container. The name covers only the second,
  smaller job.
- `maybeSaveDebugObject` (`harness/src/agent/debug/debugMessageSaver.ts:37`)
  reads the `debug.saveModelIO` setting itself and swallows failures. "maybe"
  hides the condition; one caller (`ModelInvoker.ts:228`).

**Vague file names**

- `harness/src/utils/files/varsUtils.ts:44`: one export,
  `getXmlFormatFromReadableFiles`, which reads files as prompt XML and reports
  `readable` and `skipped`. Neither name says "prompt files as XML".
- `texra/src/controllers/settingsView/sharedSettingsCommands.ts:109`: one
  export, `makeSettingsViewBody`, which builds every settings page and
  dispatches every message. "shared" records the extension/desktop merge and
  "Commands" makes it read like its siblings `settingsGitCommands.ts`.
- `harness/src/agent/memory/memoryUtils.ts`: the memory tool's display root,
  limits and display/storage path conversions. `memoryPaths.ts`.
- `texra/src/controllers/server/handlers.ts:67,85,185`: the RPC handlers plus
  the `ServiceProjects` and `ServiceControl` tags, `ServiceLoad`,
  `runningTasks` and `admit`. The CLI imports a service tag from a file named
  `handlers` (`cli/src/commands/service.ts:10`).
- `cli/src/chat/tui/input/BaseTextInput.tsx:103`: the TUI's only text input,
  rendered by six components, extended by none. "Base" promises a subclass.
- `cli/src/commands/_helpers/context.ts:19` `contextFromArgs` opens the project
  and user `config.json` stores and prints config warnings to stderr; neither
  name mentions config loading or the side effect.

Checked and left out: `BaseRunContent`, `BaseRequestPanel` (real bases with 3
and 7 subclasses); `*HandleImpl` (private); the sandbox prelude's `Real*`
captures; `ensureService` (an accurate "connect or start").

## 4. Pass-through variable

Eight chains `pass-through.md` does not name. Left out as already settled:
`SettingsStores`, `WorkspaceRoots`, `ConfigProvider` passed as data, `Scope`
parameters, `PluginEnv`, run and session ids used as keys.

| Variable                          | Chain                                                                                                                                                                                                                          | Last hop uses it for                            | Carry it instead by                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storageRoot`                     | `cli/src/runtime/platform/cliService.ts:~300` → `:324` `linkService(storageRoot, spawnOwnService(storageRoot), …)` → `texra/src/controllers/server/client.ts:559` → `:355` `ensureService`                                     | `:468`: the log path inside one timeout message | the `start` thunk already bakes the root in (`desktopService.ts:42`, `extensionService.ts:24`); put the root on it, or read the log path from the recorded service info      |
| `logger`, `fileService`, `config` | `texra/src/tools/documents/documentState.ts:142` copies them off `run` into `deps` (`:156-163`) held beside `Documents.run` → `agent/output/outputFileExtraction.ts:181-194` → `agent/output/replyDocuments.ts:302`            | debug logs and writes                           | `docs.run` already travels; `documentTools.ts:195` reads `docs.run.logger` while `:264`, `:368` read `docs.deps.logger`                                                      |
| `logger`                          | `DocumentReviewTool.ts:123` → `:50-58` `compileEvidence` (forwards only) → `agent/output/compileFailureRoundContext.ts:60-64`                                                                                                  | `:77`: one `warn` on an unreadable compile log  | a `Context.Reference` for the current trace (as `RunCall`, `ChildRuns`), or return the unreadable case as data                                                               |
| `trace`                           | `texra/src/tools/agentCli/claudeAgent.ts:321-326` → `claudeAgentShared.ts:222-234` `buildClaudeToolUseLog` (forwards only) → `:203-215` `toToolInputRecord`                                                                    | `warn` on a non-object input                    | no fiber is current there (`:210`), so return the violation as data and let the one caller warn                                                                              |
| Claude SDK options                | `claudeAgent.ts:540-553` → `:377-405` `buildClaudeAgentTurn` (forwards `cwd`, `additionalDirectories`, `env`, `pathToClaudeCodeExecutable`, `permissionMode`, `forkSession`, `resumeSessionId`) → `:150-190` `runStreamedTurn` | copies them into `ClaudeAgentSdkOptions`        | build the options object once at the tool, as `codex.ts:337-349` does with `Thread`                                                                                          |
| `fs`                              | `harness/src/tools/pluginCatalog.ts:53,123` → `tools/mcp/mcpConfig.ts:198-210` `mcpPluginLoader(fs, …)` → `:82-89` `readMcpConfig(fs, file)` (forwards only) → `:63-66` `readConfigText`                                       | `fs.readFileString`                             | require `FileSystem` in `R` and provide it once in `mcpPluginLoader`, as `pluginCatalog.ts:78` already does; `pluginRows.ts:61`, `cliConfig.ts:258` also just yield and pass |
| `progressCallback`                | `texra/src/latex/arxivProcessor.ts:451` → `:559` `fetchAndPlaceSource` (forwards at `:587`) → `:626` `stageAndPlaceSource` → `:682` `placeSourceFiles`; also `:463` → `formatter/indentDirectory.ts:60`                        | `:692,717,729` progress messages                | a `Context.Reference<(msg, pct?) => Effect<void>>` defaulting to no-op, provided once by the host command                                                                    |
| `onAsyncError`                    | `desktop/src/main/desktopWindow.ts:169-171` → `desktopNavigationPolicy.ts:33-48` (forwards three times) → `:21-27` `routeOrDeny`                                                                                               | `shell.openExternal(url).catch(onAsyncError)`   | pass the host's `openExternal`, which already reports its own failure (`desktopWindowHost.ts:89-103`)                                                                        |

## 5. Hard to describe

Eight exported interfaces whose doc has to state a protocol.

| Where                                                                                                                    | The protocol the doc imposes                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/src/chat/tui/state/sessionView.ts:43-73` `bindSessionView`                                                          | a module global must be bound before any render or key handler reads it; the rule lives in the thrown text; rebinding silently disposes the previous binding                 |
| `cli/src/chat/tui/input/textInputDisplay.ts:190-205` `textInputCappedRowCount`                                           | "callers must pass the **same** value as `maxDisplayRows`" to a second exported function, or the caret wrap is clipped                                                       |
| `texra/src/controllers/settingsView/ToolDashboardData.ts:108-127` `buildToolDashboardItems(probeInputs, cachedResults?)` | passing the second argument makes most of the first unused (only `.editor` is still read, `:186`)                                                                            |
| `texra/src/utils/text/xmlExtraction.ts:78-103` `extractDocuments(…, preferredName?)`                                     | one optional string is both the switch that enables a fallback tier and the name of the document it makes                                                                    |
| `harness/src/shared/session/transcriptReads.ts:32-48` `applyLiveText()`                                                  | three outcomes told apart by `null` versus reference identity versus a new value                                                                                             |
| `harness/src/tools/memory/memoryFileSystem.ts:394-433` `setMemoryPinned(path, pinned)`                                   | on `changed`, `pinnedCount` means the post-write total only when `pinned` was true; on an unpin it is a literal `0` (`:417`, `:431`); "Callers must not walk the tree again" |
| `desktop/src/main/desktopPtyHost.ts:66-76` `DesktopPtyHost.create`                                                       | two kinds of "no session": a rejection (native module missing) and `undefined` (disposed while loading), handled differently                                                 |
| `texra/src/tools/inquiry/inquiryRecords.ts:191-205` `markDropped`                                                        | "Only valid from `open`"; `null` covers answered, dropped, not found and a stale turn index; the caller must pass the returned manifest on                                   |

Weaker, not counted: `opResults.ts:34-46` `SessionCloseReport` ("must not
treat the close as complete disposal"), `codexImport.ts:129-136` ("should pass
the result as `codexPathOverride`"), `storeSchema.ts:191-198` `checkStamps`
(not exported).

## 6. Shallow module

The repo mostly holds up. Effect services are tags for host-supplied ports,
not wrappers, and the layers do real work (`updateCheckRecordsLayer`,
`projectDatabaseLayer`, the shared `claimThread` under the Codex and Claude
session layers). Of about 150 exported functions whose body is one `return
f(...)`, most hide a key (`getFirstRunDone`), name a number
(`storeAside.isDamaged`), are lint-allowlisted process access (`readCliCwd`)
or are documented choke points (`exposeApiKey`). Five remain; this section
is not padded to a quota.

| Where                                                                                                              | Interface vs body                                                                                                                                                                             | Consumers                                         | Fix                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `texra/src/tools/github/formatPREvent.ts:98` `formatPRIssueComment`, `formatIssueEvent.ts:22` `formatIssueComment` | each body is `formatCommentEvent(targetPath(x), c, MAX_BODY)`; `MAX_BODY = 500` is declared in both files (`:18`, `:36`); a 7-line JSDoc explains only why the two names differ               | 1 each (`issuePoller.ts:90`, `pullPoller.ts:249`) | call `formatCommentEvent` from `formatUtils.ts:108` directly; `targetPath` already takes both target types                       |
| `texra/src/controllers/settingsView/settingsViewDispatch.ts:17` `settingsViewProgram`                              | a 28-line file; the function is a table lookup with a cast under `Effect.suspend`, which the one caller already wraps                                                                         | 1 (`sharedSettingsCommands.ts:414`)               | inline the lookup; keep the file only as the registry type's home                                                                |
| `texra/src/common/files/fileListingRules.ts:64` `getEditedFileListConfig`                                          | 3 lines over the private `buildInputLikeConfig('edited')`, beside `getFileListConfig(fileType)` which already switches on the category; a comment at `:8` exists to point at this extra entry | 1 (`workspaceFileOptions.ts:64`)                  | add `'edited'` to the switch and delete the export                                                                               |
| `texra/src/common/files/fileTypeUtils.ts:18-27` `INCLUDED_EXTENSIONS` / `getIncludedExtensions`                    | a 4-row table that renames `FILE_HANDLING_RULES.included.{input,context,media,edited}Extensions` to `{input,…}`, and a getter that copies the array                                           | 6 files, 13 refs                                  | key `FILE_HANDLING_RULES.included` by `ExtensionCategory` and read it directly; keep `getFilterExtensions`, which strips the dot |
| `cli/src/runtime/platform/logSinks.ts:136,141` `flushTextStderr`, `flushStdout`                                    | both are `writeRawAndWait(stream, '')`; each JSDoc is as long as its body                                                                                                                     | 1 each (`initPlatform.ts:315-316`)                | one `flush(stream)`, or export `writeRawAndWait`                                                                                 |

Borderline, listed for completeness: `harness/src/platform/rootedFs.ts:75`
`globalStorageFsLayer` (one line over `rootedLayer`, one caller; the JSDoc's
ownership note is the only content), `harness/src/common/storage/fileLocation.ts:10-34`
`create*Location` (positional arguments over 3-field literals, 4 to 9 files
each), `cli/src/runtime/terminal/terminalText.ts:18` `textDisplayWidth` (a
rename of `stringWidth`, 11 files), `cli/src/tui/ui/theme.ts:10`
`clampModalWidth` (adds a real shared floor; leave it).

Already ruled: `ui/wa/actionButtons.ts` (J-ui-kit, "the names are the API");
`getGitHubToken` falls under the found `resolveGitHubTokenSource`.

## 7. Information leakage

Ten facts spelled in more than one module. `npm run check:fact-spread`
holds literal sets and its listed predicates shrink-only; none of these is a
`Schema.Literals` set, so the check does not see them. Skipped as already
recorded: the `team:<id>` token (general-special), the plan-route lists
(O-llm-providers), the `<documents>` output protocol (T-app-surfaces), the
`.texra/` spellings, the row-type lists in `runRowReads.ts` (round 6).

| Fact                                                                    | Sites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | What breaks                                                                                                                                                     | Owner                                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| latexdiff output filename grammar (11)                                  | `-diff<hash>` built at `texra/src/latex/latexdiff.ts:308` and `housekeeping/packLatexdiffvc.ts:55`, parsed at `latex/latexdiff/diffFileNameManager.ts:45-48`; `_diff` at `tools/latex/latexPreview.ts:83`, `latex/acceptedFileTarget.ts:299`, `latexdiffVerbs.ts:118`, `diffOperations.ts:51`, `common/files/fileHandlingRules.ts:84`, parsed at `diffFileNameManager.ts:63`; a third pair `-diff`/`-round-diff` at `agent/output/revisionLatexdiffs.ts:290` that the recognizer has no pattern for | a producer change leaves `parseVersionControlDiffFilename` (`extensionHostRequests.ts:247`), the pack sweep and the generated-artifact guard silently unmatched | `diffFileNameManager.ts`, which already calls itself "Sole owner of this grammar" but owns only `_diffr{n}r{m}` |
| bundled layout `resources/plugins/<id>/{skills,agents}` (5 + 4 scripts) | `harness/src/skills/skillSources.ts:184,205`; `agent/index/BundledAgentDirectories.ts:11` declares `'agents'` then `:43` spells `'plugins'` and `'agents'` raw; `common/plugins/pluginManifest.ts:493,517,522`; `scripts/extension-package-utils.mjs:28`, `scripts/sync-package-contributes.mjs:75`, `packages/cli/scripts/copy-resources.mjs:17`, `scripts/verify-desktop.mjs:493`                                                                                                                 | a rename drops plugin skills and plugin agents separately, since each reader treats a missing directory as "none"                                               | one `pluginResourceDir(root, id, kind)` beside `storageLayout`                                                  |
| service bundle path and argv (7)                                        | `desktop/src/main/desktopService.ts:25,26,44`; `extension/src/common/extensionService.ts:29`; producer `extension/scripts/build-serve.mjs:22-26`; `desktop/electron-builder.yml:51-54`; `scripts/verify-desktop.mjs:1038`; the CLI's `'../../../../extension/resources'` at `cli/src/runtime/platform/cliContext.ts:284`                                                                                                                                                                            | the desktop fails at startup, the extension's spawn fails with no prior check                                                                                   | one `SERVICE_BUNDLE` constant in `packages/texra`                                                               |
| `Revision ${n + 1}` (12)                                                | owner `texra/src/shared/plugins/documentOutputs.ts:62` `formatRoundLabel`, used by the UI and CLI; re-spelled at `tools/documents/documentTools.ts:227,327,345,346,349,456,458,486,509`, `DocumentReviewTool.ts:41`, `agent/output/revisionLatexdiffs.ts:142`                                                                                                                                                                                                                                       | tool results and prompts say one label while the UI says another                                                                                                | `formatRoundLabel`                                                                                              |
| agent file extension `.yaml` (9 in 4 modules)                           | `harness/src/agent/index/agentYamlScanner.ts:113`; `tools/agentCatalogFollower.ts:126`; `texra/src/controllers/settingsView/settingsAgentCommands.ts:69,71,73`; `desktop/src/shared/desktopAgentDocument.ts:6,13,16`                                                                                                                                                                                                                                                                                | accepting `.yml` in the scanner alone leaves the watcher, the creator and the desktop editor disagreeing                                                        | an `AGENT_FILE_EXTENSION` beside `BUNDLED_AGENTS_DIRECTORY`                                                     |
| `'SKILL.md'` (3)                                                        | `harness/src/skills/loadSkills.ts:130`, `skills/skillLoader.ts:294`, `common/plugins/pluginManifest.ts:560`                                                                                                                                                                                                                                                                                                                                                                                         | the plugin probe and the loader disagree about what is a skill                                                                                                  | a `SKILL_FILE` constant in `common/`                                                                            |
| `https://texra.ai` and its guide URL scheme (6)                         | owner `texra/src/ui/copy/guide.ts:10` ("the one place every host and renderer builds them", pages need `.html`); `cli/src/commands/installGithubAction.ts:42` writes `/guide/code-review` with no `.html`; the bare origin at `cli/src/commands/root.ts:149`, `extension/src/frontend/ui/welcomeView.ts:32`, `desktop/src/renderer/workbenchController.ts:242`, `desktop/src/main/desktopNavigationPolicy.ts:15`                                                                                    | a domain change misses these and the desktop navigation policy refuses the new host                                                                             | `guide.ts`, exporting the origin                                                                                |
| `TEXRA_OUTPUT_FORMAT` read twice (2)                                    | `cli/src/commands/version.ts:17` (own parser, raw flag) and `cli/src/runtime/platform/cliContext.ts:492-497` (`pickEnv`, with warnings and the config fallback)                                                                                                                                                                                                                                                                                                                                     | `texra version` ignores the config tier and drops the invalid-value warning                                                                                     | `cliContext`'s tier resolution                                                                                  |
| `TEXRA_APPROVAL_POLICY` as a literal (2 packages)                       | read at `cli/src/runtime/platform/cliContext.ts:482`; withheld from children at `harness/src/utils/system/envFlags.ts:89`                                                                                                                                                                                                                                                                                                                                                                           | a rename in the CLI leaves the harness withholding a dead name, which is the case the withhold exists to prevent                                                | `harness/src/shared/approvalPolicy.ts`, which already documents the variable                                    |
| `texra-agent:` URI scheme (5)                                           | owner `desktop/src/shared/desktopAgentDocument.ts:6,11,16`; `desktop/src/main/desktopWorkspaceIpc.ts:343,366` branch on `path.startsWith('texra-agent:')` instead of `agentDocumentIdentity`                                                                                                                                                                                                                                                                                                        | a scheme change sends agent documents down the workspace-path branch                                                                                            | `desktopAgentDocument.ts`, exporting `isAgentDocumentTarget`                                                    |

Checked and owned already: command ids (`satisfies CommandId[]`), SQL table
names (inside `controllers/session`), IPC channels (`hostBridgeChannels.ts`),
`.mcp.json` (`mcpServers.ts:35`).

## 8. Consistency

No earlier audit searched for this. Where the code already agrees, in
numbers: every service is `class X extends Context.Service<…>()` (70) or a
`Context.Reference` (18), with no `Context.Tag`, `ServiceMap` or
`Effect.Service`; every `Layer.succeed` is the curried form (27); all 53 tools
go through `defineTool` (the hand-built MCP tool at `mcpServer.ts:181` has a
raw JSON Schema and no Effect Schema, so it cannot); no tool input uses
`Schema.optional(S)` without `NullOr` or `Schema.Number`; there is no
`Data.TaggedError`. The ten splits:

| Convention                            | Majority (count)                                                                              | Minority (`path:line`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Guide says                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| service key string                    | harness `'@texra-ai/harness/<area>/<Name>'` (~60); llm, cli `'@texra-ai/<pkg>/…'`             | texra `'@texra/…'` (16) though its package is `@texra-ai/texra`, at varying depth (`'@texra/InquiryRecords'`, `'@texra/tools/EditorHost'`); bare colon keys `'agent:launches'`, `'agent:keys'` (`agent/runtime/delegation/agentChild.ts:49,246`), `'agent:request'` (`proposalFlow.ts:142`); `liveTools.ts:89,101` declare `ToolCatalog` as a `const` plus interface, not a class                                                                                                                                                                                                                                                                                                  | nothing                                                                                          |
| where a service's layer lives         | a separate `fooLayer` export (27)                                                             | `static layer` on the class (17): `controllers/session/sessionSources.ts:36,82,104`, `sessionViewService.ts:61,151`, `platform/appSignals.ts:198`, `texra/src/shared/session/sessionFrames.ts:239`, `controllers/server/hostWindows.ts:406`; both at once in `tools/codemode/ScriptTool.ts:388`                                                                                                                                                                                                                                                                                                                                                                                    | nothing                                                                                          |
| service module file case              | camelCase (57)                                                                                | PascalCase (11), mixed inside `harness/src/agent/runtime/`: `ModelInvoker.ts`, `ModelRetryGate.ts` (holds `RouteRetries`), `HostInteractions.ts` (holds `Interactions`) beside `requests.ts` (holds `SessionRequests`), `runRegistry.ts` (holds `Runs`), `rootLaunch.ts` (holds `SessionOwner`). `controllers/session/SessionRequests.ts` exports the function `sessionRequests` while the `SessionRequests` service is in `agent/runtime/requests.ts`. `*Service.ts` means an Effect service (`toolAvailabilityService.ts`), a plain class (`AgentDirectoryService.ts:72`, `SubscriptionUsageService.ts:92`) or functions plus a layer (`texra/src/telemetry/UsageLogService.ts`) | symbols PascalCase; files unsaid                                                                 |
| tool module file case                 | `XxxTool.ts` (36)                                                                             | `harness/src/tools/bash.ts`, `glob.ts`, `grep.ts` beside `EditTool.ts`, `ReadTool.ts`, `WriteTool.ts`; `texra/src/tools/agentCli/claudeAgent.ts`, `codex.ts`; `github/githubSubscriptionTool.ts`; `documents/documentTools.ts` beside `DocumentReviewTool.ts`                                                                                                                                                                                                                                                                                                                                                                                                                      | nothing                                                                                          |
| error construction                    | `Schema.TaggedError` classes (harness 60, texra 49, llm 13, cli 8, extension 12, desktop 5)   | `Effect.fail(new Error(…))`: harness 51 (clustered in `agent/storage/childRunOutput.ts:39-116`, `agent/index/pluginAgents.ts`), texra 17, cli 24 (more than its tagged errors: `commands/service.ts:189-257`, `commands/tasks.ts:87,204`, `runtime/models/modelAccess.ts:323,464`); `Effect.fail` of a bare string at `texra/src/controllers/session/hostDraftRequests.ts:223`                                                                                                                                                                                                                                                                                                     | `Schema.TaggedError`; `Error` only for a port whose hosts fail differently                       |
| how a tool body reports failure       | `new ToolError(…)` (107 uses, 31 files)                                                       | raw `new Error`: `harness/src/tools/web/WebSearchTool.ts:108`, `texra/src/tools/lean/LoogleTool.ts:144`, `documents/documentTools.ts:126` (the same file uses `ToolError` at `:145,215,262`); a successful `errorResult(…)`: `PlanTool.ts:249,275`, `SelfTool.ts:119,221`, `LoogleTool.ts:185-224`, `LspTools.ts:129-270`. `WebSearchTool.ts:103-111` and `LoogleTool.ts:139-147` validate an HTTP JSON body under the same comment, one with `decodeUnknownResult` + `Result.isSuccess`, the other with `schemaBodyJson` + `catchTag`                                                                                                                                             | decode with `decodeUnknownEffect` in Effect code                                                 |
| reading a JSON file                   | `Schema.fromJsonString(S)` (24)                                                               | `Effect.try(JSON.parse)` then `decodeUnknownEffect` with a hand-written "not valid JSON" message: `common/plugins/pluginManifest.ts:147`, `tools/mcp/mcpConfig.ts:92`; the `safeParseJson` Result helper (`common/parsing/safeParseJson.ts:15`, two users); `JSON.parse` + `Predicate.isObject` + thrown `TypeError` at `platform/defaults/jsonStore.ts:50`, and an Effect copy of it at `:75-83`                                                                                                                                                                                                                                                                                  | nothing specific                                                                                 |
| logging in desktop main               | `Effect.log*` + `withLogChannel('desktop')` (16)                                              | `console.*` (14). One file does both for one event: `desktopWindow.ts:124,130,145` `console.warn` for dropped renderer messages, `:153,329,358` `Effect.logWarning` for the same; `desktopIpcTypes.ts:34` returns an Effect but logs with `Effect.sync(() => console.warn)`; `desktopProjects.ts:245,359`, `desktopProjectBindings.ts:129`, `desktopWindowHost.ts:46,49`                                                                                                                                                                                                                                                                                                           | `Effect.log*` with `withLogChannel`; oxlint bans `console` only in the cli zone                  |
| async style in desktop main           | `Effect.gen` / `Effect.fn` (62)                                                               | `async` (6): `platform/warningDialog.ts:8` awaits `dialog.showMessageBox` and its caller `desktopProjects.ts:244` does `.catch(console.warn)`, while `desktopDialogs.ts:177` wraps the same call in `Effect.tryPromise`; `desktopPtyHost.ts:159,171`; `desktopNavigationPolicy.ts:26`; `desktopBrowserViews.ts:92,176`                                                                                                                                                                                                                                                                                                                                                             | async logic is Effect                                                                            |
| where a tool input default is applied | in the schema with `nullishWithDefault` (19 files; `bash.ts:131`, `SendToTerminalTool.ts:37`) | at dispatch: `codemode/ScriptTool.ts:57` is `optional(NullOr)` and `:242` applies `?? DEFAULT_TIMEOUT_MS`; `grep.ts:69` `head_limit` is plain `optional(NullOr)` beside `nullishWithDefault` for `output_mode` (`:35`) and `offset` (`:64`)                                                                                                                                                                                                                                                                                                                                                                                                                                        | both rules in `packages/harness/AGENTS.md` "Tool input schemas"; unsaid for a plain struct field |

The desktop main process is the one place where two conventions the guide
settles (Effect logging, Effect for async) are both split in the same files.

## 9. Configuration parameters and knobs

Nine knobs a fact, a constant or the only caller already decides. None is in
`2026-11-03-fewer-processing-options.md` or `refuted-candidates.json`. Every
`*_SETTING` row has at least one non-UI reader, so no setting is dead; the
other `process.env` reads are documented or set by build scripts.

| Knob                                                                                                                                                                  | Production values                                                                                                                                                                                                                                                        | What already decides it                                                                              | Fix                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StreamOptions.deferStart` (`harness/src/agent/trace/AgentTrace.ts:32`, branched at `TraceEmitter.ts:162`)                                                            | 2 callers, both `ModelInvoker.ts:262,265`, both `true`; the eager branch is reached only by `test/transcript/TexraTranscriptRecorder.vitest.ts:45`                                                                                                                       | the interface comment already says an eager stream "must not announce a phase that may never happen" | make deferred the only behaviour; drop `StreamOptions` and `openRun`'s options (it is in `plugins.ts:216`, no in-repo plugin calls it)                                                                     |
| `CliPlatformOptions.installSignalHandlers` (`cli/src/runtime/platform/initPlatform.ts:59`, read at `:259`)                                                            | 0 production callers; the 8 `platform:` bags set only `startsService` and `presentsStoreMovedAside`; the one `false` is the dev script `cli/scripts/tui-harness.tsx:341`, excluded from the package                                                                      | always install; the dev harness can wrap its own policy with `holdSignals` as the chat TUI does      | delete the field                                                                                                                                                                                           |
| desktop open dialog `allowMultiple` (`desktop/src/main/desktopFileSelection.ts:15`, `desktopWindowHost.ts:206,214`)                                                   | 1 caller (`desktopFileSelection.ts:72`), `true`, and it always passes the optional `defaultPath`                                                                                                                                                                         | `pickFiles` is documented as "the native picker for one multi-file list"                             | hard-code `['openFile','multiSelections']`; make `defaultPath` required                                                                                                                                    |
| `renderSplitButtonMenuParts` `triggerAppearance` / `triggerVariant` (`texra/src/ui/wa/splitButton.ts:22-23`, defaults `:80-81`)                                       | 1 caller (`BaseRequestPanel.ts:344`), passing `'accent'`, `'brand'`, the same values it gives the main button at `:341-342`                                                                                                                                              | the trigger matches the main button                                                                  | hard-code; delete both fields                                                                                                                                                                              |
| `<list-pagination>.pageSize` and `DEFAULT_PAGE_SIZE` (`extension/src/settingsView/frontend/components/shared/Pagination.ts:23,28,88`)                                 | 1 user (`components/memory/MemoryList.ts:80,96`), which passes the default explicitly both times                                                                                                                                                                         | no other page size exists                                                                            | a module-private `PAGE_SIZE`; drop the property and parameter                                                                                                                                              |
| `KatexHtmlProcessorOptions.errorColor` (`texra/src/ui/markdown/katexHtmlProcessor.ts:30,72`)                                                                          | 1 caller (`ui/progress/formatters/markdownRenderer.ts:14-15`), the constant `'var(--color-error)'`                                                                                                                                                                       | one design token                                                                                     | inline; `createKatexHtmlProcessor()` takes no arguments                                                                                                                                                    |
| `renderSettingsNumberRow` `revertOnEmpty` beside `onClear` (`texra/src/ui/wa/settingsSection.ts:134`, branched `:188`)                                                | a cleared field means revert, commit 0, or `onClear`; `revertOnEmpty: false` 2× (`AgentsTab.ts:251,255`), `onClear` 1× (`SubscriptionSection.ts:190`); the doc at `:130,147` names a "provider reliability section" that no longer calls it                              | one clear hook suffices: the two rows pass `onClear: () => onChange(0)`                              | delete `revertOnEmpty`; fix the doc                                                                                                                                                                        |
| `countPinnedMemories(limit?)` and `walkMemoryDirectory(…, relativeRoot = '')` (`harness/src/tools/memory/memoryFileSystem.ts:371`, `:325-327`)                        | `limit` has 1 caller (`:419`), always `MAX_PINNED_MEMORIES`, so the `undefined` branch at `:379-380` is dead; `relativeRoot` has 3 callers (`:347`, `:376`, `MemoryTool.ts:510`), all `''`                                                                               | the cap and the root are constants                                                                   | inline the cap; delete `relativeRoot` and its threading through `walkLevel`                                                                                                                                |
| interop skill discovery: `SkillSourceOptions.includeInterop` (`harness/src/skills/skillSources.ts:12,137,178`) plus `skills.disabledSources` (`stateSettings.ts:388`) | the flag's only producer is the CLI (`cliContext.ts:529`, `--include-interop`, `globalArgs.ts:117`); GUI hosts pass no `skillSourceOptions`, so their "Imported" scope (`SkillsTab.ts:34`) can never hold a skill; on the CLI the setting means nothing without the flag | two keys for one decision; `disabledSources` already has an `'interop'` scope                        | always discover the interop roots and let `disabledSources` gate them (default: `'interop'` disabled); delete the flag and the resume-hint plumbing (`resumeHint.ts:51-52`, `interruptedResumeHint.ts:33`) |

Checked and left alone because callers vary: `resolveWritableTarget.missing`,
`pdfStemSuffix`, `ExecuteCommandBaseOptions.quiet` / `buffer` /
`killProcessTree`, `runningTasks(atWork)`, `UsageLogOptions.hostTelemetryEnabled`,
`AssemblyOptions.allowMissingResponseId`, `Settings.set(target)`, `getTeXCount`
mode. Already refuted or recorded: `DownloadSourceOptions.autoIndent`
(`refuted-candidates.json`), `OpenOptions.persistent` (general-special),
`TEXRA_DESKTOP_HEADLESS`, the `*_CUSTOM_HEADERS` variables.
`ProcessServicesOptions.toolAvailability` (`sessionLayer.ts:319`) was a
candidate; the test kernel does pass it (`src/test-kernel/support/testKernel.ts:257`),
as its doc says, so it is a test handle, not a knob.

## Totals

| Section | Flag                                      | New items | Verdict                                                                            |
| ------- | ----------------------------------------- | --------: | ---------------------------------------------------------------------------------- |
| 1       | comment repeats code                      |        15 | ~1% of JSDoc; old Lit components and `@param` blocks                               |
| 2       | implementation docs contaminate interface |        16 | the SDK entry files are clean; the re-exported JSDoc is not                        |
| 3       | hard to pick name, vague name             |        14 | "process" and "context" each mean 3 to 4 things                                    |
| 4       | pass-through variable                     |         8 | loggers, `fs`, callbacks; `Context.Reference` fits most                            |
| 5       | hard to describe                          |         8 | pairs of exports that must agree, `null` with 3 meanings                           |
| 6       | shallow module                            |         5 | mostly fine                                                                        |
| 7       | information leakage                       |        10 | file-name grammars and resource layouts; outside `check:fact-spread`'s view        |
| 8       | consistency                               |        10 | service keys, file case, error construction; desktop main splits two settled rules |
| 9       | knobs                                     |         9 | constant-per-caller fields; one decision under two keys                            |
