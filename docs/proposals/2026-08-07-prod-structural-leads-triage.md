# Production structural leads — triage of the second-pass harvest (2026-08-07)

Method: the 101-partition tuned simplification pass (#9829) returned 307
cross-file leads its agents could not act on across partition boundaries.
21 read-only verifier agents re-checked every lead against post-merge main
(#9827/#9828/#9829 landed), refute-by-default, with the do-not-do ledgers
(#8758/#8974) and frozen ratchets as rejection grounds.

**Verdicts: 307 triaged → 113 confirmed, 34 partial, 10 stale (already fixed
by today's merges), 150 refuted.** The refuted half is mostly: fix would
net-add elements, surface is a deliberate port/vocabulary seam, claim's
specifics wrong on current HEAD, or single-caller-extraction-ban violations.

Waves below are sized for #9828-style fix PRs (one theme, one owner, gates
per wave). Full machine-readable verdicts: /tmp/prod-leads-verified.json
(session-local; regenerate via workflow wf_e5709b0d-2e7 journal if gone).

## Partial — real problem, lead shape wrong (needs design) (34)

- **transcriptViewport.ts estimateEntryRows wraps transcriptEntryLayout in try/catch returning a 1-row fallback — an M2-ish silent swallow worth error-pipeline L-classification**
  evidence: packages/cli/src/chat/tui/panes/transcriptViewport.ts:19-26: bare `catch { return FAILED_ENTRY_ESTIMATE_ROWS; }` (constant at :11) with no log; feeds estimateTranscriptEntryRows/estimateLiveTranscript
  fix: Error-pipeline owner: the fallback is real but the fix is classification, not deletion — either add a warn-log (a layout throw on an entry the renderer would otherwise show is a real defect worth surfacing) or document i
- **BaseTextInput.tsx textInputDisplayRowCount is exported but production-internal; only external consumer is TextInputEditing.vitest.ts — but memory says InputBar windowing SHOULD use it, so it is a planned consumer**
  evidence: packages/cli/src/chat/tui/input/BaseTextInput.tsx:276 export, consumed in-file by textInputCappedRowCount (:296) and by src/test-kernel/cli/TextInputEditing.vitest.ts:20,316-339; zero external prod co
  fix: Keep the export. The test-only-export wave should skip this symbol; the correct shape is the planned InputBar windowing rework consuming it, after which the export has a real prod consumer. Deleting now would force re-ad
- **inputHistory.ts uses Zod .catch(0) on persisted history timestamps — M3 masking shape on a persisted read; may want .prefault or a line-skip**
  evidence: packages/cli/src/chat/tui/history/inputHistory.ts:17 `z.object({ t: z.number().catch(0), v: z.string() })` on the persisted history file; loadInputHistory (:43-57) already skips unparseable lines via
  fix: Error-pipeline/CLI owner: drop `.catch(0)` so a record with a corrupt timestamp fails validation and is skipped by the existing unwrapOr(undefined) line-skip — no new code, one schema edit. `.prefault(0)` would preserve
- **preflightCliTeamAvailability has one caller (orchestrate.ts); inline the CLI adapter body and delete the module**
  evidence: Single prod caller confirmed (commands/orchestrate.ts:261). The adapter (teamAvailabilityPreflight.ts:23-39) is options assembly with 3 lines of real glue (missingAgents flatten + teamHostedNamesForPr
  fix: CLI runtime owner — legal inline per single-caller rule, but the module is the dedicated test seam (CliTeamAvailabilityPreflight.vitest.ts invokes it 7+ times); right shape is inline the assembly at orchestrate.ts:261 AN
- **knip-baseline lists 7 dead-export findings in VscodeIntegration.ts that are really LeanLanguageServices port members knip can't see through setLeanLanguageServices**
  evidence: config/ratchets/knip-baseline.json:45-79 lists executeFileCommand/executeProjectCommand/fetchDiagnosticsForFile/getGoalState/getHoverInfo/getTermGoal/navigateToFirstError for packages/extension/src/fr
  fix: Better shape than the lead's comment/config-note: at packages/extension/src/extension.ts:523 pass an explicit object literal `setLeanLanguageServices({ executeFileCommand, getGoalState, ... })` with named imports — knip
- **dispatchMessage re-validates ProgressViewOutboundMessageSchema while every host caller also safeParses first (double parse)**
  evidence: packages/extension/src/progressView/frontend/messageDispatcher.ts:61-66 delegates to createDispatcher which safeParses internally (src/shared/utils/dispatcher.ts:138-148); the ONLY pre-checking caller
  fix: Owner: desktop renderer. Replace main.ts:1565-1567 with a bare `dispatchMessage(event.data)` — it returns false on parse failure with no onError, so routing/silence behavior is byte-identical and the double parse disappe
- **SettingsProfileController.getProviderDisplayName/getProviderKeyUrl exist largely to be re-injected as deps into SettingsProfileKeyController by host wiring (apiKeyCommands.ts + desktopCredentialSettingsController.ts) …**
  evidence: The cited extension wiring does NOT self-carry: packages/extension/src/commands/api/apiKeyCommands.ts:37-42 and packages/extension/src/settingsView/SettingsViewMessageHandler.ts:197-202 both wire the
  fix: Owner: desktop settings wiring. Not a chain collapse — a 1-site wiring alignment: make desktopCredentialSettingsController.ts:181-184 wire the key-controller deps the way both extension sites already do ((provider) => ge
- **ClientCompactionResult didCompact:false always returns compactedMessages===input, so handler-side didCompact forks can collapse to unconditional compactedMessages**
  evidence: Invariant verified: src/agent/modelHandlers/ModelHandler.ts:1375,1460,1471,1499 all return `{ compactedMessages: messages, didCompact: false }`. The fork at src/agent/modelHandlers/openai/modelHandler
  fix: modelHandlers/openai owner: in modelHandlerOpenAI.ts createResponseImpl, drop the didCompact destructure and updatedMessages intermediate — `const { compactedMessages: messagesToUse } = await this.maybeCompactByInputToke
- **desktopCredentialSettingsController signOut/setPrefer/refresh twin pairs are a fourth codex/xai subscription-twin instance that should consume an owned-elsewhere parameterized helper**
  evidence: Duplication is real and NOT stale: #9828 (ba163c0eec) collapsed codex/xai twins in CLI commands/runtime, extension frontend auth, and src/auth coordinators, but never touched this file — signOutChatGp
  fix: Owner: desktop host. Add local private parameterized methods in the same file, mirroring the file's own signInSubscription (:263-297) and refreshAfterSubscriptionAuthChange (:417-427) patterns: one signOutSubscription({c
- **openFileCompile is a one-line pass-through (single-caller inline candidate); runLatexdiffFile wraps fileActions.runLatexdiffFile in a try/catch worth auditing for masking**
  evidence: openFileCompile half is true: packages/desktop/src/main/desktopAgentExecution.ts:1276-1278 is `return this.fileActions.openFileCompile(filePath)` with exactly one prod caller (line 850) — but the lead
  fix: Owner: desktop host / test-only-export wave. Inline at line 850 (`(file) => this.fileActions.openFileCompile(file)`), reroute DesktopAgentExecutionFactory.vitest.ts:458 through commands.file.openFileCompile, then delete
- **auth.ts loginInitFromArgs/assertLoginTransportExclusive/shouldPromptForLoginProvider exported solely for LoginArgs.vitest.ts plus one internal caller each — unexport-and-inline candidate**
  evidence: Partially wrong on the key symbol: loginInitFromArgs has a real second prod consumer — packages/cli/src/commands/orchestrate.ts:74 imports it and calls it at :284 and :377 (plus auth.ts:211). The othe
  fix: test-only-export wave — applies only to assertLoginTransportExclusive and shouldPromptForLoginProvider (drop `export` once LoginArgs.vitest.ts is refactored to drive loginCommand). loginInitFromArgs must stay exported; o
- **toolCallParsing.ts exports type DuplicateCallMap with no importer outside its own file — candidate for unexport, verify against knip baseline first**
  evidence: src/agent/core/flows/toolUseRound/toolCallParsing.ts:21,44-45 — zero external importers (grep incl. string refs); not in config/ratchets/knip-baseline.json; but it is the declared return type of expor
  fix: test-only-export wave N/A; owner: agent-core flows. Plain unexport fails TS4023 (private name in exported signature) under the packages/agent d.ts build. Right shape: change partitionDuplicateCalls' return annotation to
- **DuplicateCallMap is consumed only inside its own file (ToolUseDispatchNode re-declares Map<string, number> inline); could be unexported or deleted outright — left alone because it is the declared return type of partit…**
  evidence: src/agent/core/flows/toolUseRound/ToolUseDispatchNode.ts:99,124 (declares `new Map<string, number>()`, receives partitionDuplicateCalls result without importing the alias); toolCallParsing.ts:21; pack
  fix: Same issue as the sibling DuplicateCallMap lead, one fix covers both. Owner: agent-core flows. Inline Map<string, number> as partitionDuplicateCalls' return annotation (ToolUseDispatchNode needs no change), relocate the
- **StreamLogStore and StreamSnapshotStore independently implement per-stream dirty-write serialization with near-identical retry caps — shared dirty-writer primitive**
  evidence: StreamLogStore.ts:263 dirtyIds+debounce+executeWrite, :1043 MAX_WRITE_RETRIES=3; StreamSnapshotStore.ts:88 MAX_DIRTY_WRITE_RETRIES=3, :341 writeMutexes map, :1318 retryDirtyWrites. Different concurren
  fix: Observation accurate but the proposed shared primitive is a 2-subsystem convergence trap (refactor-LOC lesson: cross-divergent abstraction net-adds). Decline unless flush semantics are formally unified; at most share the
- **computePrice params typed X | null in openai/openrouter/google handlers — do inner null guards duplicate UsageNormalizer's boundary check?**
  evidence: Abstract contract is non-null (ModelHandler.ts:1555 `abstract computePrice(responseUsage: U)`); implementations widen to `| null` (modelHandlerOpenAI.ts:955, modelHandlerOpenRouterNative.ts:570, model
  fix: Real but small: narrow the three implementation signatures to the abstract's non-null U and drop the redundant guards, updating the one test that pins computeGoogleInteractionsPrice(null). Owner: modelHandlers partition;
- **AgentWorkspaceState.reasoning carries both thinkingBlocks and thinkingAdded — boolean derivable from thinkingBlocks.length > 0**
  evidence: AgentWorkspaceState.ts:203-205 (schema pair, both prefault), :489-492 resetReasoning resets both; all four write sites set/clear both in lockstep, and consumption at modelHandlerAnthropic.ts:1414 alre
  fix: Derivability verified at current write sites. Right shape: delete thinkingAdded from ReasoningCacheStateSchema and derive at the 4 guard sites, treating legacy persisted booleans as disposable (loud-degradation ruling);
- **OutputNode is sole prod caller of outputState one-liners hasRoundOutputs/hasCompileFailures (and getStorageKey/setCompileFailures/setActiveRun) — inline to remove exports**
  evidence: src/agent/output/outputState.ts:122-128 — the two 2-line accessors have exactly one prod caller (OutputNode.ts:131,150) and zero test consumers. But the parenthetical is wrong: getStorageKey has 3 pro
  fix: Owner: agent output. Inline ONLY hasRoundOutputs/hasCompileFailures into OutputNode.ts (delete outputState.ts:122-128); leave getStorageKey/setActiveRun — multi-consumer. setCompileFailures (sole caller OutputNode) is a
- **Test-only production exports: resumeHint.ts formatResumeUsage, transcript.ts resolveLocalTranscriptStreamId**
  evidence: formatResumeUsage (packages/cli/src/chat/tui/state/resumeHint.ts:94): only non-test use is intra-module (resumeHint.ts:165) — export exists solely for ResumeHint.vitest.ts. resolveLocalTranscriptStrea
  fix: test-only-export wave. formatResumeUsage: confirmed wave candidate (unexport or test through the public formatter). resolveLocalTranscriptStreamId: NOT zero-consumer — the TUI harness imports it; wave must repoint the ha
- **modelHandlerGoogleInteractions.ts carries ~8 comments referencing 'the chat handler' though no chat Google handler exists anymore**
  evidence: Core claim real but specifics stale: 4 comments found (not ~8), at src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts:722, 788, 1088, 1207 (lead's line numbers predate #9827/#9829). The
  fix: Owner: model handlers. Comment-only PR: re-anchor the 4 dangling references to name the deleted GenAI chat handler as historical lineage (e.g. 'the removed GenAI chat handler, deleted in 20e08318a6') or prune where the n
- **taskGroupProjection.ts GroupLogPayloadSchema.catch({}) and AgentDirectorySync.readSyncMarker .catch(undefined): silent-default parses on trace/persisted data**
  evidence: readSyncMarker (src/agent/index/AgentDirectorySync.ts:139): a schema-validation failure on valid JSON is swallowed to undefined with no warn, unlike the outer catch which warns (line 143) — genuine si
  fix: Owner: agent index. readSyncMarker: replace .catch(undefined) with safeParse + logger.warn on failure (mirror the existing warn at line 143), ~3 lines. Leave taskGroupProjection .catch({}) — deliberate lenient parse over
- **src/shared has recurring test-kernel-only exports (8+ instances); needs a ruling doc before deletion**
  evidence: Theme is real (consistent with leads 2 and 23 verified by grep), but this lead names zero specific symbols — '8+ instances this partition' is unverifiable as stated.
  fix: test-only-export wave — the separate campaign already owns the theme; this lead contributes only the process note (ruling doc before per-symbol deletion), no actionable symbols.
- *_Dead exports: EditInput, OpenPdfInput, CodexCliReasoningEffort, AgentWorkspaceOptions, and 5 settingsView *Ports interfaces imported nowhere*_
  evidence: Wrong on 3 of 5: EditInput consumed by packages/extension/src/progressView/frontend/formatters/logFormatters/toolFormatters/toolSections.ts; CodexCliReasoningEffort by src/tools/codex.ts; AgentWorkspa
  fix: test-only-export wave — real residue is OpenPdfInput (dead export, delete) and dropping `export` from locally-used Ports interfaces; discard the lead's other named items.
- **figCommands.ts/arXivCommands.ts quick-pick label string surgery; convert to MarkupItem value-field pattern**
  evidence: packages/extension/src/commands/latex/figCommands.ts:48 has `selected.label.split(' (')[0]` — real. But arXivCommands.ts:34,39 already uses the value-field pattern (`value: 'references'`, `destination
fix: Owner packages/extension/src/commands/latex: add a `value: label` field to the figCommands quick-pick item (item built at figCommands.ts:35-39) and read selected.value; single-site fix, no 'UI-wide canon pass' warranted.
- **AgentReviewService.issuePath falls back to path.join('',file); clear() never resets reviewRoot**
  evidence: Facts verified: packages/extension/src/frontend/review/AgentReviewService.ts:139 `path.join(this.reviewRoot ?? '', issue.file)` and clear() at :456-462 resets issues/dismissed/summary/pendingCommitRev
  fix: Owner packages/extension/src/frontend/review: small loud-degradation tidy — either clear reviewRoot in clear() or drop the `?? ''` and have issuePath require reviewRoot; NOT the lead's 'derive from presence of issues' co
- `store.ts` MULTI_FILE_LIST_BY_SET_COMMAND typed `Record<string, ...|undefined>` forces a runtime guard; type over the exact `SET_*` union instead
  evidence: Accurate: store.ts:120-122 casts Object.fromEntries to Record<string, MultiFileList | undefined>, forcing `if (!list) return` at the sole consumer documentSlice.ts:45-46. The guard is statically unnee
  fix: Owner packages/extension/src/webview/frontend: tighten the cast to Record<SetMultipleFilesMessage['command'], MultiFileList> (honest — all four keys provably present) and delete the guard; typing-only change, no schema t
- **store.ts MULTI_FILE_LIST_BY_SET_COMMAND Object.fromEntries+cast forces narrowing guard; derive record type from entries keys**
  evidence: Duplicate of the previous lead, same evidence: store.ts:104-122 derivation chain and documentSlice.ts:45-46 guard. Same adjudication — real but a ~2-line typing fix.
  fix: Same as the twin lead: tighten the fromEntries cast to the SetMultipleFilesMessage['command'] union and drop the guard; single tiny PR.
- **src/tools/setup/index.ts barrel: extension.ts is the only setSetupPlatform-via-barrel consumer; repoint to shrink the barrel to registry-only**
  evidence: src/tools/setup/index.ts (10 re-exports) has two consumers: src/tools/registry.ts:64-74 ('./setup', 10 tool classes) and packages/extension/src/extension.ts:95 ('@tools/setup', setSetupPlatform); desk
  fix: The lead's shape (repoint extension.ts only) nets zero — the barrel stays for registry. Right shape if done at all: full collapse — registry.ts deep-imports the 9 tool modules, extension.ts imports '@tools/setup/platform
- **src/utils/files/index.ts is a convenience barrel (CLAUDE.md bans these) with ~50 importers — large out-of-partition rewrite**
  evidence: src/utils/files/index.ts exists with a curated header ('Core filesystem abstractions' / 're-exported for convenience' / explicit NOT-re-exported list); actual prod importer count is ~140 files, not ~5
  fix: Owner: dedicated barrel-retirement epic (same shape as #9828's four barrel deletions). Re-point ~140 importers to './workspaceFS', './mimeUtils', './taskRunStorage' etc. Needs an owner ruling first on whether @utils/file
- **taskRunStorage.ts:34-55 re-export block is a dual surface; ~11 importers could import from fileLocation/runStorageFs directly**
  evidence: src/utils/files/taskRunStorage.ts:40-62 re-exports fileLocation/runStorageFs symbols under an explicit 'Public entry point: external consumers import these ... through @utils/files/taskRunStorage' doc
  fix: Owner: same barrel-retirement epic as the @utils/files lead. Retire the re-export block together with the barrel in one PR, re-pointing the ~11 importers (src/agent/output, src/agent/runtime, src/tools, src/housekeeping,
- **TeXCountStat is a single-field wrapper; parseTeXCountStats could return string[]; consumers TeXCountNode + latexCommands**
  evidence: Wrapper is real (src/latex/texcount.ts:285-287, { label: string }), but the consumer analysis is wrong: TeXCountNode.ts:3 uses getTeXCountStats (returns string|null), never TeXCountStat. Sole parseTeX
  fix: latex owner: parseTeXCountStats returns string[], delete TeXCountStat, latexCommands needs no change (showQuickPick takes string[]), update TeXCountStats.vitest.ts expectations to bare strings. −1 interface; 3-file edit
- **pathResolution/formatting/fileEditFlow shared helpers: multi-caller, likely keepers, but worth a dead-export check**
  evidence: Mostly keepers confirmed, but the check uncovers real targets: replaceFirstLiteral/replaceAllLiteral/findOccurrenceLineNumbers (src/tools/fileEditFlow.ts:26,50,68) have zero external prod consumers —
  fix: test-only-export wave: unexport the three fileEditFlow internals (or test them through replaceLiteralMatches); drop the two formatting type exports if knip baseline permits. Remaining exports all have live multi-caller u
- **getCodexCliReasoningEffort is a one-line composition with one prod caller; inline into codex.ts**
  evidence: src/tools/codexConfig.ts:61-63 (composition of module-private getCodexReasoningEffort + toCodexCliReasoningEffort); sole prod caller src/tools/codex.ts:463 via lazy namespace import; mocked in CodexRe
  fix: Owner: src/tools. Claim verified but naive inline is impossible across the module boundary: the clean shape is exporting the raw enum getter instead and composing toCodexCliReasoningEffort(getCodexReasoningEffort()) at c
- **workflowOutput filename-era compat grammar may be deletable early per the #9590 intermediate-era-data ruling**
  evidence: Consumers verified: src/housekeeping/utils.ts:11-13, src/housekeeping/pack.ts:9,259, src/latex/latexdiff/diffOperations.ts:21-22,234,261, packages/extension/src/commands/latex/compareCommands.ts:25,17
  fix: Consumer map is accurate, but this is a product ruling, not a defect: deleting breaks housekeeping-packing and latexdiff against pre-rename run outputs. Right shape per #9590: one deletion PR owned across housekeeping/la
- **commitAcceptedFile target shape duplicated as ReplaceOrCopyTarget in compareCommands.ts; export one named target type**
  evidence: packages/extension/src/commands/latex/compareCommands.ts:159-162 ReplaceOrCopyTarget = {targetLocation, targetFileName}; identical to src/latex/acceptedFileTarget.ts:16-20 AcceptedFileTarget minus isN
  fix: Owner: src/latex + extension commands. Duplication is real but tiny (2 fields); right shape is exporting a named base target type (e.g. FileWriteTarget) from acceptedFileTarget.ts and deriving both. Net ~zero elements, s

## Wave A — test-only production exports (paired prod+test edits) (52)

- **inputKeys.ts metaChordDigit has zero production callers — only TextInputEditing.vitest.ts (4 assertions) — delete export and assertions together**
  evidence: packages/cli/src/chat/tui/input/inputKeys.ts:68 definition; grep across packages+src shows no prod consumer; only src/test-kernel/cli/TextInputEditing.vitest.ts:30,161-164
  fix: test-only-export wave: delete metaChordDigit from inputKeys.ts and the 4 assertions (TextInputEditing.vitest.ts:161-164) plus its import (:30) in one commit.
- **inputKeys.ts isShiftReturnInput is production-internal (only isTextInputNewlineInput calls it); test-only external consumer — delete-with-test pairing opportunity**
  evidence: packages/cli/src/chat/tui/input/inputKeys.ts:99 definition, prod use only same-file at :121 (isTextInputNewlineInput); external consumers only src/test-kernel/cli/TextInputEditing.vitest.ts:28,48-60
  fix: test-only-export wave: unexport isShiftReturnInput (keep as module-local helper for isTextInputNewlineInput) and retarget the TextInputEditing assertions at the public isTextInputNewlineInput, or delete the direct-predic
- **DiffView.tsx diffVisualRowCount is a one-line .length wrapper with one prod caller (EditApproval.tsx) pinned by DiffView.vitest.ts — inline via source+test co-change**
  evidence: packages/cli/src/chat/tui/render/DiffView.tsx:163-168 returns wrappedDiffDisplayLines(...).length; wrappedDiffDisplayLines is already exported (:150); sole prod caller packages/cli/src/chat/tui/modals
  fix: DiffView/EditApproval owner: EditApproval calls `wrappedDiffDisplayLines(hunks, diffWidth).length` directly (swap the import), delete diffVisualRowCount, and re-point DiffView.vitest.ts:258 at wrappedDiffDisplayLines. Ne
- **readCliHistoryConfig and expandWorkflowInputSpecs are test-only exports with zero production callers; deletable once tests migrate**
  evidence: grep: readCliHistoryConfig defined packages/cli/src/runtime/history.ts:221, only consumer src/test-kernel/cli/History.vitest.ts:121,571. expandWorkflowInputSpecs defined packages/cli/src/runtime/workf
  fix: test-only-export wave — delete both exports after retargeting History.vitest to the execution-store read path and the two input suites to expandRunInputs/withExpandedRunInputs. ~2 exports removed.
- **formatCliNoRunnableModelsLaunchBlock + modelAccessLaunchBlockDescriptionForCliMode form a collapsible two-function chain over one copy lookup**
  evidence: packages/cli/src/runtime/modelAccess.ts:220-224 (inner fn is a one-line table lookup) whose only prod caller is the same-file outer fn at :309; only external importer of the inner export is src/test-k
  fix: test-only-export wave — inline the table lookup into modelAccessLaunchBlockDescriptionForCliMode, delete the inner export, retarget ModelAccess.vitest.ts:624-631 to the outer function or the copy table. −1 export.
- **BUILTIN_DEFAULT_CHAT_MODEL is a pure alias of CLI_BUILTIN_DEFAULT_MODEL whose only consumer is ChatDefaults.vitest.ts**
  evidence: packages/cli/src/runtime/chatDefaults.ts:42 `export const BUILTIN_DEFAULT_CHAT_MODEL = CLI_BUILTIN_DEFAULT_MODEL;` — CLI_BUILTIN_DEFAULT_MODEL already imported at :17 and used directly by sibling runM
  fix: test-only-export wave — switch chatDefaults.ts:162,234 to CLI_BUILTIN_DEFAULT_MODEL, delete the alias line, repoint ChatDefaults.vitest.ts to CLI_BUILTIN_DEFAULT_MODEL. −1 export, −1 line.
- **loadCliApiStatusLines is a single-production-caller pass-through; inline at orchestrate.ts:213 with a coordinated test edit**
  evidence: packages/cli/src/runtime/apiStatus.ts:333-337 body is `[...(await loadCliApiStatus(options)).lines]`; only prod caller commands/orchestrate.ts:213; other consumer is the dedicated describe block in sr
  fix: test-only-export wave — inline `(await loadCliApiStatus({ apiMode })).lines` at orchestrate.ts:213, delete the wrapper, retarget ApiStatusLoad.vitest's describe to loadCliApiStatus. −1 export.
- **updateChecker.ts: 8 of 9 exports are test-only; only notifyCliUpdate is production-live**
  evidence: grep over packages/ and src/: detectInstallMethod(:58), isPackageManagerInstall(:95), buildUpdateCommand(:102), formatUpdateCommand(:128), fetchLatestCliVersion(:134), fetchLatestHomebrewFormulaVersio
  fix: test-only-export wave — judgment call per the wave: either unexport the 8 and test through notifyCliUpdate, or keep a minimal surface. Largest single file in the batch (~250 lines of prod surface pinned by one suite).
- **runtime/completion.ts is a one-consumer facade of re-exports plus generateCompletionScript; fold into commands/completion.ts**
  evidence: packages/cli/src/runtime/completion.ts:12-13 are pure re-export shims (CLI_COMPLETION_SHELLS, parseCompletionShell, CliCompletionShell from completionCommandTree) — banned convenience-barrel shape. So
  fix: CLI runtime owner — move the generateCompletionScript dispatch (completion.ts:15-28) into commands/completion.ts as its single caller, import parseCompletionShell/CLI_COMPLETION_SHELLS from completionCommandTree there, d
- **getAgentRegistrationSkipReason export exists solely for test-kernel register.vitest.ts; inline into promptToAddAgentToConfig**
  evidence: packages/extension/src/frontend/agents/register.ts:15-20 exports the function returning 'alreadyRegistered'|undefined; only prod use is same-file register.ts:31 used as a boolean; only external consum
  fix: test-only-export wave: inline `configuredAgents.includes(agentName)` into promptToAddAgentToConfig, delete AgentRegistrationSkipReason union + exported function + the dedicated describe block in register.vitest.ts.
- **Vestigial carrier param: agentCategory on resolveCodexSubscriptionCapabilitiesForAgentCategory is accepted and never read; isCodexSubscriptionActive's agentCategory only feeds it**
  evidence: src/model/providerCapabilities.ts:165-172 — agentCategory (line 168) never appears in the body; isCodexSubscriptionActive (175-188) takes agentCategory and only forwards it (line 184). The xAI twin re
  fix: Owner: src/model/providerCapabilities.ts. Drop agentCategory from both signatures (and optionally rename the resolvers to drop the now-misleading ForAgentCategory suffix), update the ~8 prod callers and 5 vitest files. P
- **formatters/index.ts re-exports isStreamingTextLogMessage solely for the LogDeltaTextDeltas test**
  evidence: packages/extension/src/progressView/frontend/formatters/index.ts:40 `export { isStreamingTextLogMessage } from './baseLogFormatter'` — grep shows the only consumer of that re-export is src/test-kernel
  fix: test-only-export wave: point the vitest at '@progressView/frontend/formatters/baseLogFormatter' and delete the formatters/index.ts:40 re-export. 2 files, net −1 line.
- **progressBackendAppSignals.ts is a single-caller pass-through adapter; inlining needs the vi.mock string-path hazard handled**
  evidence: packages/extension/src/progressView/progressBackendAppSignals.ts:8-17 is an 18-line module wrapping one `signals.on('extensionDeactivating', …)` subscription; the only prod caller is packages/extensio
  fix: Owner: extension progressView. Inline the 3-line subscription into ProgressViewProvider.initialize() (this._disposables.push), delete progressBackendAppSignals.ts and ProgressBackendAppSignals.vitest.ts, remove the vi.mo
- **LatexdiffExecutionResult.source/executionId are test-only observable surface (both prod callers destructure only { outcome }); fields + LatexdiffOutputsSource could collapse if tests update**
  evidence: Verified zero prod consumers of the two fields: the only prod call sites destructure only outcome — packages/extension/src/commands/latex/latexdiffCommands.ts:357 and packages/desktop/src/main/desktop
  fix: test-only-export wave: drop source + executionId from LatexdiffExecutionResult (runLatexdiff.ts:74-79,164), delete the LatexdiffOutputsSource type and the local source-tracking variable, and rewrite RunLatexdiff.vitest.t
- **checkToolResultTextLimit has no production caller outside its own file — only same-file use by formatToolResultAsText plus a direct test-kernel import; drop the export if the test goes through the wrapper**
  evidence: grep: src/agent/modelHandlers/utils/toolAttachmentUtils.ts:179 (definition) and :278 (same-file call from formatToolResultAsText) are the only prod hits; the only other importer is src/test-kernel/age
  fix: test-only-export wave. Caveat for the wave owner: the test exercises custom maxLength arguments (vitest lines 59-87) while formatToolResultAsText (line 278) only ever uses the default limit, so routing the test through t
- **DesktopProgressBridge.deleteStream/deleteAllStreams have no production callers; only the DesktopAgentExecution vitest uses them**
  evidence: packages/desktop/src/main/desktopAgentExecution.ts:1131-1137 (public wrappers over this.backend). Exhaustive grep over packages/desktop/src and src shows zero prod callers — the real user-action path
  fix: test-only-export wave: reroute DesktopAgentExecution.vitest.ts deletion tests through the commands.lifecycle / ProgressViewCommandHandlers inbound path (or the backend directly), then delete the two public wrapper method
- **Knip coverage gap: 4 electronSecrets.ts + 1 warningDialog.ts baseline entries are actually consumed by src/test-kernel; fixing knip's entry/scope for test-kernel could clear baseline entries repo-wide without code cha…**
  evidence: All 5 config/ratchets/knip-baseline.json entries verified test-consumed: getSecretStorageMode / KEYCHAIN_DENIED_WARNING_MESSAGE / LINUX_BASIC_TEXT_SECRET_STORAGE_MESSAGE via src/test-kernel/desktop/El
  fix: test-only-export wave / config-level sweep, not per-file edits: teach the packages/desktop knip workspace to treat the loadSourceModule-pinned modules as reachable (entry hints or equivalent config), then regenerate and
- **formatUpdatedDate has a single production caller (MemoryItem.ts:163) plus direct test-kernel coverage; inline the formatShortDateTime + 'Updated' prefix/'Updated: unknown' fallback at the caller and drop the wrapper t…**
  evidence: src/shared/utils/string.ts:36-41; sole prod consumer packages/extension/src/settingsView/frontend/components/memory/MemoryItem.ts:163; test coverage at src/test-kernel/shared/DateTimeFormatters.vitest
  fix: Owner: extension settingsView webview. In MemoryItem.renderMeta use a temp: `const updated = formatShortDateTime(item.mtime); parts.push(updated ? `Updated ${updated}` : 'Updated: unknown');`, add formatShortDateTime to
- **src/latex exports kept alive solely by test-kernel imports: buildKpathseaSearchPath, buildLatexInputEnv, buildLatexSearchParts, resolveArxivPaperDirectoryRelative, diffCommandExecutor flag helpers, ArxivProcessor.down…**
  evidence: texTools.ts:47/74/103 and arxivProcessor.ts:59/158 — each has only same-file prod use; all external consumers are src/test-kernel/latex/TexTools.vitest.ts:6-8, ArxivProcessor.vitest.ts:8, LatexdiffBib
  fix: test-only-export wave: unexport (or move helpers next to tests) with the coordinated test-kernel rewrite; ~8 production export elements shed.
- **StreamStatusMachine.has() is test-only; ProgressViewStoresWiring.vitest.ts:25 could assert get(stream) === undefined, then delete the method**
  evidence: src/agent/runtime/StreamStatusService.ts:281 has() — sole consumer anywhere is src/test-kernel/progressView/ProgressViewStoresWiring.vitest.ts:25; zero prod consumers verified by grep
  fix: test-only-export wave. Change the one assertion to session.status.get(stream) === undefined and delete has() (StreamStatusService.ts:281-283). ~2 elements.
- **refreshRuntimeModelRegistry and shouldRouteModelThroughCopilot have test-kernel-only consumers; rerouting tests could drop both exports**
  evidence: refreshRuntimeModelRegistry: grep shows consumers only in 3 test-kernel files (ModelFactoryRouting, ModelHandlerVscodeLm, RuntimeModelRegistry vitests), zero prod. shouldRouteModelThroughCopilot (src/
  fix: test-only-export wave. Both verified zero external prod consumers; wave decides reroute-vs-unexport per symbol.
- **ProviderCapabilities.vitest.ts imports only codex-side symbols; resolveXaiSubscriptionCapabilitiesForAgentCategory has no direct unit coverage**
  evidence: src/test-kernel/model/ProviderCapabilities.vitest.ts:22 imports only resolveCodexSubscriptionCapabilitiesForAgentCategory; grep for resolveXaiSubscriptionCapabilities/isXaiSubscriptionActive/xai-subsc
  fix: Owner: model tests. Add an xai block to ProviderCapabilities.vitest.ts mirroring the codex cases: preference off -> null, useOpenRouter -> null, non-XAI provider -> null, openRouterOnly -> null, happy path returns authMo
- **ProgressBackend.applyStreamStatus/applySessionFact/applyRunFact are prod methods consumed ONLY by test-kernel vitest files**
  evidence: src/controllers/progressView/backend/ProgressBackend.ts:194-211 — three thin pass-throughs to factApplier; grep shows zero prod consumers, only src/test-kernel/progressView/ProgressBackendRetainedChil
  fix: test-only-export wave. Verified zero prod consumers. Wave makes the test-seam decision (move to a test helper vs keep as documented host-seed seam — the doc comments claim 'rare host seeds' but no host uses them).
- **Unexported-but-still-exported types (CreateLifecycleHostOptions, StatCapableFs, FileLockTuning, NodePlatformServices, etc.) have no non-test importers**
  evidence: grep across src+packages: StatCapableFs (src/platform/defaults/fsEntryTypeBits.ts), FileLockTuning (fileLocks.ts), NodePlatformServices/NodeAgentDirectoryBootstrapOptions/NodeRuntimeSkillOptions (node
  fix: test-only-export wave — batch with the knip-baseline shrink campaign; most of these have zero consumers anywhere (drop `export` keyword or delete the type), the resolve* group is test-kernel-only.
- **15 zero-production-caller exported types (AppendFollowUpResult, CurrentToolContexts, SeverityCounts, ...) prunable by type-export audit**
  evidence: Verified by grep: 14/15 appear in exactly one prod file (their definition) with no external prod importer, e.g. SeverityCounts, PatchApplyResult, TextDiffOptions, MultipleExtractionResult. One false m
  fix: test-only-export wave — fold the 14 verified members (minus CurrentToolContexts) into the type-export audit; most are local-only export keywords or inference-consumed result types.
- **RestartRepairResult is production-write-only except nextLeaseCheckAt; shrink the interface and delete createRestartRepairResult plus per-stream array plumbing (~5 elements)**
  evidence: src/agent/runtime/restartRepair.ts:64-80 (5 array fields + factory); sole prod caller SessionHandle.ts:625-647 reads only result.nextLeaseCheckAt (:647); the arrays are written at restartRepair.ts:322
  fix: Owner: agent-runtime + test-kernel (same PR). repairRestartedStreams returns { nextLeaseCheckAt?: number }; delete createRestartRepairResult, the 5 push lines (:322-326), and the per-stream arrays in repairRestartedStrea
- **StopReasonTypes.ts: delete OPENAI_COMPLETION_FINISH (values duplicate OPENAI_CHAT_FINISH) and trim MCP_STOP to MAX_TOKENS — needs paired test-kernel edit**
  evidence: src/agent/types/StopReasonTypes.ts:22-27 (OPENAI_COMPLETION_FINISH: stop/length/content_filter — all present in OPENAI_CHAT_FINISH:9-15); its only prod uses are the redundant TOKEN_LIMIT_STOP_REASONS
  fix: Owner: agent/types + test-kernel (same PR). Delete OPENAI_COMPLETION_FINISH + its token-limit entry + union member; trim MCP_STOP to { MAX_TOKENS } (MCPStopReason collapses, union simplifies); update stopReasonUtils.vite
- **src/tools/setup/platform.ts:88 'export type { TerminalRunResult }' has test-only consumers; repoint tests to '@hosts/uiHosts' and delete**
  evidence: src/tools/setup/platform.ts:88 re-export; prod code imports TerminalRunResult from '@hosts/uiHosts' (definition src/hosts/uiHosts.ts:116; prod user packages/extension/src/frontend/setupTerminalRunner.
  fix: test-only-export wave: repoint the two test imports to '@hosts/uiHosts', delete platform.ts:88 (the :18 import stays — used internally by the SetupPlatform interface).
- **InputBar.tsx shouldPersistInputHistory and submitSlashCommandWhenReady are exported single-prod-caller wrappers whose only other consumer is InputBar.vitest.ts**
  evidence: packages/cli/src/chat/tui/panes/InputBar.tsx:78-80 (one-line negation of shouldRedactSlashInput, single prod use :285) and :99-122 (single prod use :321); only other importer is src/test-kernel/cli/In
  fix: test-only-export wave: inline '!shouldRedactSlashInput(historyText)' at :285 and the runWhenIdle+slashSubmitText body at :321; delete both exports. Repoint the history test at shouldRedactSlashInput directly; for the sub
- **browser.ts windowsVerbatimArguments is false on every platform branch; delete the field, three literals, and the spawn option (paired test edit)**
  evidence: packages/cli/src/runtime/browser.ts:8 (interface field), :24/:32/:38 (all three literals false), :50 (spawn option; node spawn default is false so removal is behavior-identical). Only test reference:
  fix: Owner: cli runtime + test-kernel same PR. Delete the BrowserLaunchCommand field, the 3 branch literals, and the spawn option; drop the assertion at BrowserLaunch.vitest.ts:41. ~-6 elements.
- **diffCommandExecutor.ts exports buildLatexdiffTextCommandExclusionFlag and resolveLatexdiffSubtype consumed only by test-kernel — un-export both**
  evidence: src/latex/latexdiff/diffCommandExecutor.ts:38,44 — both have internal prod uses (:130, :279) but the only external importer is src/test-kernel/latex/LatexdiffBibQuality.vitest.ts:4-7.
  fix: test-only-export wave: drop both 'export' keywords; rework LatexdiffBibQuality.vitest.ts to assert the exclusion-flag/subtype behavior through the executor's public entry (mocked spawn) or accept indirect coverage via ex
- **DelegationTools.ts re-export of rejectOversizedBibAttachments exists only for DelegationTools.vitest.ts**
  evidence: src/tools/delegation/DelegationTools.ts:62 `export { rejectOversizedBibAttachments } from './inputFields'`; all prod consumers import from './inputFields' directly (WorkflowScriptTool.ts:49, workflowS
  fix: test-only-export wave: re-point DelegationTools.vitest.ts:43 to '@tools/delegation/inputFields', delete DelegationTools.ts:62. One line + one import edit.
- **formatters/index.ts re-exports isStreamingTextLogMessage solely for LogDeltaTextDeltas.vitest.ts**
  evidence: packages/extension/src/progressView/frontend/formatters/index.ts:40 re-export; only external consumer is src/test-kernel/progressView/LogDeltaTextDeltas.vitest.ts:3; internal prod use (index.ts:162) f
  fix: test-only-export wave: re-point the test to '@progressView/frontend/formatters/baseLogFormatter', delete index.ts:40. (Leads 10 and 11 are the same finding.)
- **formatters/index.ts:40 re-export is test-only; pair barrel deletion with test re-point**
  evidence: Duplicate of the previous lead — packages/extension/src/progressView/frontend/formatters/index.ts:40, sole external consumer src/test-kernel/progressView/LogDeltaTextDeltas.vitest.ts:3
  fix: test-only-export wave: same fix as above; dedupe the two leads into one edit.
- **FollowUpQueue.drain() has zero prod callers — only TuiStateAndFocus.vitest.ts:3352; switch test to drainItems() and delete**
  evidence: src/agent/followUp/FollowUpQueue.ts:100-102 drain() = drainItems().map(displayTextForItem); grep for '.drain(' across src+packages shows only src/test-kernel/cli/TuiStateAndFocus.vitest.ts:3352; the '
  fix: test-only-export wave: switch the test to drainItems() (mapping item.text or displayText as needed), delete drain() and the stale back-compat comment. displayTextForItem survives (still used at FollowUpQueue.ts:172).
- **TEXRA_ICON_NAMES only consumed by DesktopIconLibrary.vitest.ts — test could read TEXRA_ICON_CANONICAL_NAMES; delete the duplicate frozen keys-array**
  evidence: src/shared/wa/webAwesomeIcons.ts:328-330 export; only consumer is src/test-kernel/desktop/DesktopIconLibrary.vitest.ts:11,101; iconNames.ts:12-13 documents the satisfies constraint keeping TEXRA_ICON_
  fix: test-only-export wave: re-point DesktopIconLibrary.vitest.ts to TEXRA_ICON_CANONICAL_NAMES from '@shared/wa/iconNames', delete TEXRA_ICON_NAMES (webAwesomeIcons.ts:327-330).
- **TeamPlan.ts teamExecutionFields/buildTeamOptions consumed externally only by test-kernel — unexport if knip baseline tightens**
  evidence: src/common/teams/TeamPlan.ts:207,223 exports; internal use at :277 and :372; the only external importer is src/test-kernel/common/teams/TeamPlan.vitest.ts:4,12 — zero external prod consumers verified
  fix: test-only-export wave: drop the export keyword on both functions once TeamPlan.vitest.ts exercises them through the public parse/plan API (or the wave's policy keeps direct unit access). Needs knip-baseline check. (Leads
- **buildTeamOptions/teamExecutionFields exported; only test-kernel + internal ReturnType anchor — drop exports in a dedicated pass**
  evidence: Duplicate of the previous lead — src/common/teams/TeamPlan.ts:207,223; sole external consumer src/test-kernel/common/teams/TeamPlan.vitest.ts
  fix: test-only-export wave: same edit as above; dedupe.
- **Test-only exports in CLI tui files (tuiInputModeRestoreSequence, stripAnsiSgrChunk, sgrStrippingWriteStream, COMPACT_FORM_MAX_ROWS) — repo-policy sweep territory**
  evidence: packages/cli/src/tui/terminalCleanup.ts:83 (internal use :93), noColorOutput.ts:13,67 (internal use :82,:110), selectWindow.ts:13 (internal use :16) — grep confirms every external consumer is in src/t
  fix: test-only-export wave: policy decision per symbol — either unexport and test via the public entry (writeTerminalSequence / colorEnabled wrapper / isCompactRows), or keep as the wave's accepted direct-unit-test pattern.
- **src/tools/latex/index.ts 3-line convenience barrel; delete and point registry.ts at defining files**
  evidence: src/tools/latex/index.ts:1-3 re-exports three tool classes; only prod consumer src/tools/registry.ts:23; three test imports (@tools/latex in ExtractFiguresTool/ExtractTikzFiguresTool/ExtractBibliograp
  fix: tools owner: delete the barrel; registry.ts imports ExtractLatexFiguresTool/ExtractBibliographyTool/ExtractTikzFiguresTool from their defining files; repoint the 3 vitest imports to deep paths. −1 file, −1 element
- **Delete addCdataToTags (zero prod callers, test-only); bonus: wrapTagsWithCdata attrPattern then collapses**
  evidence: src/utils/text/xmlCdata.ts:61-63 addCdataToTags has zero prod callers (only src/test-kernel/utils/text/xmlUtils.vitest.ts:9,90,108); addCdataToTagsMultiple is prod-used (src/agent/output/XmlOutputMana
  fix: test-only-export wave: delete addCdataToTags + its vitest cases, inline the '(?:\\s+[^>]*)?' attr pattern into wrapTagsWithCdata dropping the parameter. −1 export, ~−25 lines incl. tests
- **Test-only export sweep: addCdataToTags, pastedImageFileName, BinaryResolverService class, FollowUpQueue.drain**
  evidence: All four verified: pastedImageFileName export consumed only by FilesUtils.vitest.ts:27 (internal prod use at src/utils/files/pastedImageUtils.ts:16,50); BinaryResolverService class imported only by Sy
  fix: test-only-export wave: unexport pastedImageFileName and the BinaryResolverService class (keep singleton), delete or inline FollowUpQueue.drain into the harness, fold addCdataToTags per its own lead. Prod+test move togeth
- **Repoint completedRunArchive.vitest.ts:149 type at TranscriptWriter['append'], then collapse five single-caller writer-mutator wrappers in StreamLogStore**
  evidence: src/transcript/StreamLogStore.ts:723-810 — append/appendSettled/update/settle/appendText are pure pass-throughs to appendEntry/mutateEntry, each with exactly one caller: the createWriter closures (:58
  fix: transcript owner: closures call this.appendEntry(streamId, entry, false|true) and this.mutateEntry(streamId, log => log.update/settle/appendText(...)) directly; delete the 5 private methods; repoint the vitest type to Pa
- **transcript barrel entries streamDataDir and StreamLog have no prod consumer outside the barrel; flip test imports to deep paths and drop both**
  evidence: src/transcript/index.ts:18,20. streamDataDir's prod consumers (StagedDeletionCoordinator.ts:45, StreamSnapshotStore.ts:72) use the deep './streamDataPaths' path; external consumers are test-kernel onl
  fix: test-only-export wave: repoint the 3-4 test imports to '@transcript/streamDataPaths' / '@transcript/StreamLog', delete barrel entries index.ts:18 and :20 (keep the StreamLogAppendInput type entry if referenced). −2 barre
- **childActivityReducer header claims webview+CLI sharing but only prod caller is SessionFactApplier — stale comment or move into caller**
  evidence: src/shared/streams/childActivityReducer.ts:1-3 claims 'shared by the webview progress-view backend and the CLI TUI'; grep shows the sole prod caller is src/controllers/session/SessionFactApplier.ts:48
  fix: controllers owner: minimal fix = rewrite the header to name SessionFactApplier as the single owner serving both hosts. Optional deeper fix = move the pure fn into SessionFactApplier as module-local and repoint the vitest
- **wolframScriptUtils executeWolframScriptFile + WOLFRAM_FILE_TIMEOUT_MS have zero production callers (test-only)**
  evidence: src/tools/wolfram/wolframScriptUtils.ts:88,7; only consumer is src/test-kernel/tools/Wolfram.vitest.ts:19,172; WolframTool.ts:19-22 imports only WOLFRAM_CODE_TIMEOUT_MS/executeWolframCode
  fix: test-only-export wave: delete executeWolframScriptFile and WOLFRAM_FILE_TIMEOUT_MS (~25 lines incl. doc comment), rewrite the two Wolfram.vitest.ts cases against runWolfram behavior or drop them. Owner: src/tools.
- **desktopTaskShell reopenWorkbench/workbenchTab/WORKBENCH_KINDS have zero external prod callers (test-only)**
  evidence: packages/desktop/src/shared/desktopTaskShell.ts:14,141,300; external prod consumers (renderer/main.ts:122-123, renderer/taskShell.ts) use only workbenchTabsForPlacement/workbenchTabDomId/workbenchTabs
  fix: test-only-export wave: unexport all three (reopenWorkbench stays reachable via toggleWorkbench at desktopTaskShell.ts:325), trim the vitest imports to exercise public surface.
- **xaiJwt accessTokenIsExpiring + extractXaiClaims have zero prod consumers (barrel + test only)**
  evidence: src/auth/xai/xaiJwt.ts:50,64; XaiSessionCoordinator.ts:87 comment explicitly avoids extractXaiClaims; only consumers are src/auth/xai/index.ts:13-15 (barrel) and src/test-kernel/auth/XaiJwt.vitest.ts:
  fix: test-only-export wave: delete both functions from xaiJwt.ts, drop the two barrel lines, delete/rewrite the two vitest cases (expiry logic can be covered through decodeXaiJwtClaims if desired).
- **CodexAuthorizeRequest alias survives in codex barrel while xai twin was un-exported; check barrel consumers**
  evidence: src/auth/codex/CodexSessionCoordinator.ts:40 alias; re-exported at src/auth/codex/index.ts:34; xai twin is module-private (XaiSessionCoordinator.ts:41); only consumer of the codex alias is src/test-ke
  fix: test-only-export wave: make the alias module-private like the xai twin, drop index.ts:34 re-export, repoint the test to SubscriptionAuthorizeRequest from @auth/oauth. Mirrors the landed twin-dedup shape (#9828).
- **onboardingFunnel.ts re-exports OnboardingFunnelState; two host consumers could import from @shared/schemas directly**
  evidence: src/controllers/onboarding/onboardingFunnel.ts:18-20 pure type re-export; consumers packages/extension/src/webview/MainViewProvider.ts:24 and packages/desktop/src/main/desktopOnboardingIpc.ts:3 import
  fix: Owner: controllers + two hosts. Repoint the two prod imports (and OnboardingFunnel.vitest.ts:7) to @shared/schemas/onboarding, delete onboardingFunnel.ts:20. Per import-the-defining-file rule; ~4 line edits.
- **getOnboardingDeclined has no prod caller outside its module; unexport once test migrates to readOnboardingFlags**
  evidence: src/shared/state/onboardingState.ts:13; only in-file use at :57 (readOnboardingFlags); external use only src/test-kernel/cli/OnboardingState.vitest.ts:12
  fix: test-only-export wave: unexport the function (keep module-private), rewrite the four vitest cases through readOnboardingFlags.
- **TierService fake in ServerSideKeyService.vitest.ts:67 still defines getAccessDescription(), dead mock surface after prod removal**
  evidence: src/test-kernel/auth/ServerSideKeyService.vitest.ts:67-69 defines getAccessDescription() in the fake; grep across all of src/ and packages/*/src finds zero other references — src/auth/serverKeys/TierS
  fix: test-owning pass (fleet is test-restricted): delete the 3 lines 67-69 (`getAccessDescription() { return 'No included model access'; },`) from the fake in ServerSideKeyService.vitest.ts. Single-file, ~3-line deletion, no

## Wave B — barrel / re-export retirement (14)

- **approvalQueue.ts `export type { ApprovalBypassKind }` has exactly one consumer (ConfirmCard.tsx) — repoint to '@shared/approvalBypassKind' and delete the re-export**
  evidence: packages/cli/src/chat/tui/state/approvalQueue.ts:35 re-export; sole consumer packages/cli/src/chat/tui/modals/ConfirmCard.tsx:26-29 (multi-line type import from '../state/approvalQueue'); every other
  fix: ConfirmCard owner: split the type import — ApprovalBypassKind from '@shared/approvalBypassKind', ApprovalDecision stays from '../state/approvalQueue' — then delete approvalQueue.ts:18 import (if unused) and :35 re-export
- **isNativeAgentRun predicate (`identity?.kind === 'agent' && identity.tool === undefined`) has one owner in controllers but 3 more copies (StreamHeader.ts:357, subscribeStreamLog.ts:153 negated, resumeHint.ts:139) — can…**
  evidence: Canonical: src/controllers/progressView/ProgressViewCommandHandlers.ts:50-52. Copies: packages/extension/src/progressView/frontend/components/StreamHeader.ts:356-357 (exact), packages/cli/src/chat/tui
  fix: Shared-schemas owner: add `export function isNativeAgentRun(identity: RunIdentity | undefined): boolean` to src/shared/schemas/runIdentity.ts; re-export the controllers copy from it (ProgressViewCommandHandlers keeps its
- **agent.ts carries dual type aliases AgentSourceType and AgentSource for the same z.infer<>; collapsing requires editing out-of-assignment consumers**
  evidence: src/shared/schemas/agent.ts:58 (`export type AgentSourceType = z.infer<typeof AgentSourceSchema>`) and agent.ts:64 (`export type AgentSource = AgentSourceType`) — two names, one type. AgentSource has
  fix: Owner: shared/schemas. Keep `AgentSource` (the name with 20 consumers), delete `AgentSourceType`: update AgentSelectionPanel.ts (5 uses, import already from '@shared/schemas/agent') and switch packages/agent/src/schemas.
- **outputFileUtils.getOutputFileName is a pure pass-through of workflowOutputPath({ext, round}) with two call sites; inline and delete**
  evidence: src/agent/utils/outputFileUtils.ts:23-25 body is exactly `return workflowOutputPath({ ext: extension, round });`; only two callers, both in src/agent/implementations/flows/reflection/runReflectionFlow
  fix: Owner: agent/flows. Inline `workflowOutputPath({ ext: WORKFLOW_RAW_OUTPUT_EXT, round })` / `WORKFLOW_DOCUMENT_OUTPUT_EXT` at runReflectionFlow.ts:160,168, relocate the TaskRunFileService MUST-resolve warning comment (out
- **LitSessionRenderer.ts imports AgentCategory via deep import '@agent/core/definition/AgentDataclass' while sibling agentProposalTransport.ts uses '@shared/schemas'; normalizing aligns with ratchet shrink direction**
  evidence: src/controllers/progressView/backend/LitSessionRenderer.ts:1 imports from '@agent/core/definition/AgentDataclass', which merely re-exports the symbol (src/agent/core/definition/AgentDataclass.ts:11 'e
  fix: Owner: progressView backend. One-line import change in LitSessionRenderer.ts:1 to '@shared/schemas'; retires a pointless re-export hop and shrinks the @agent deep-import edge in the ratchet's shrink direction. 1 element.
- **progressView store.ts re-exports isToolUseState/isWorkflowState/StreamState/ToolUseStreamState/WorkflowStreamState from '@shared/schemas' — test-led repoint would retire the block**
  evidence: packages/extension/src/progressView/frontend/store.ts:17-22 re-export block; prod importers via the store include eventHandlers.ts:14, WorkflowStreamContent.ts:12, streamHeaderView.ts:17 (plus stateUt
  fix: Owner: progressView frontend. Repoint the ~4 prod component imports (and test-kernel imports) to '@shared/schemas' directly, delete store.ts:17-22. No-convenience-barrels rule: import the file that defines the symbol. ~6
- **settingsState.ts is the only consumer of the 'export { type Goal } from './goal'' re-export in settingsViewMessages.ts; repoint and delete**
  evidence: src/shared/schemas/settingsViewMessages.ts:18 (re-export); packages/extension/src/settingsView/frontend/settingsState.ts:54 imports type Goal from '@shared/schemas/settingsViewMessages' but already im
  fix: Owner: extension settingsView frontend. Move 'type Goal' into settingsState.ts's existing '@shared/schemas' import; delete settingsViewMessages.ts:15-18 (comment + re-export). Do NOT import the leaf '@shared/schemas/goal
- **Delete barrel src/tools/lean/index.ts; sole importer registry.ts; repoint to './lean/LspTools' + './lean/LoogleTool'**
  evidence: src/tools/lean/index.ts (9-line pure re-export of 5 tool classes); sole importer src/tools/registry.ts:46-52 ('from './lean''); no vi.mock or other references (grep over src, packages, src/test-kernel
  fix: Owner: tools/registry. registry.ts imports LeanDiagnosticsTool/LeanFileTool/LeanProjectTool/LeanInspectTool from './lean/LspTools' and LeanLoogleTool from './lean/LoogleTool'; delete src/tools/lean/index.ts. -1 file, ~ne
- **src/tools/lean/index.ts is a pure re-export barrel with exactly one importer (registry.ts); collapse (duplicate of the earlier lean-barrel lead)**
  evidence: Same as the lean-barrel lead: src/tools/lean/index.ts; src/tools/registry.ts:52 sole importer; no mocks. Duplicate lead, one fix.
  fix: Same fix as the other lean-barrel entry — land once: repoint registry.ts to './lean/LspTools' + './lean/LoogleTool', delete index.ts.
- **src/utils/core/index.ts could import serializeError directly from 'serialize-error'; delete the stringUtils re-export (one hop shorter)**
  evidence: src/utils/text/stringUtils.ts:3,23 imports and re-exports serialize-error solely for src/utils/core/index.ts:31; no file imports serializeError from '@utils/text/stringUtils' or 'serialize-error' dire
  fix: Owner: utils/core. In core/index.ts replace the stringUtils sourcing with export { serializeError } from 'serialize-error' (move the doc comment); delete stringUtils.ts:3 and :23. -2 lines, zero risk. Marginal but legal.
- **packages/extension/src/common/webview/index.ts is a pure re-export barrel (8 consumers, 2 vi.mock by string, ratchets reference paths) — dedicated barrel-retirement PR**
  evidence: packages/extension/src/common/webview/index.ts is 5 named re-exports and nothing else; 8 prod consumers (extension.ts, MainViewProvider.ts, extensionCommandSurface.ts, SettingsViewProvider.ts, Setting
  fix: Owner: CLI/extension host. Re-point the 8 prod importers + 2 vi.mock strings to './BaseViewContentProvider', './BaseViewMessageHandler', './BaseWebviewProvider', './viewState', './resourceRoots'; delete index.ts. ~11 fil
- **runPack (pack.ts:167-177) single-caller dispatcher; inline into packCommands.ts:59 and delete**
  evidence: src/housekeeping/pack.ts:167-177 is a pure ternary dispatcher; sole caller packages/extension/src/commands/housekeeping/packCommands.ts:59; runPackSingle/runPackMultiple already imported directly by t
  fix: cli/extension housekeeping owner: replace packCommands.ts:59 with outputFiles.length>0 ? runPackMultiple(...) : runPackSingle(...), delete runPack from pack.ts and from the barrel src/housekeeping/index.ts:7. ~2 elements
- **src/tools/goal/index.ts 3-line barrel violates no-barrels rule but has ~15 prod importers + vi.mock/dynamic-import path refs — needs a string-path-aware cross-partition sweep**
  evidence: src/tools/goal/index.ts:1-3 re-exports isGoalEnabled/GoalStore+subscribeGoalStateChanges/setGoalSessionBashAutoApproval; 29 files import '@tools/goal' across src/agent, src/controllers, and all three
  fix: cross-partition sweep (single dedicated PR): repoint all ~29 import sites plus the vi.mock/dynamic-import path strings to the defining files (goalFeatureFlag/goalStore/goalAutoApproval), then delete index.ts. Mechanical;
- **src/tools/latex/index.ts is a pure 3-line re-export barrel; delete per no-convenience-barrels rule**
  evidence: src/tools/latex/index.ts (3 re-export lines, no logic); prod consumer src/tools/registry.ts:23 (`} from './latex'`); test consumers ExtractFiguresTool/ExtractBibliographyTool/ExtractTikzFiguresTool vi
  fix: Owner: src/tools. Repoint registry.ts:23 to the three defining files and the three test imports likewise, delete index.ts. Same shape as the landed #9828 barrel deletions.

## Wave C — cross-subsystem duplication (8)

- **dialogs.ts selectFile is a single-external-caller wrapper over selectFiles; sole caller fileSelectionCommands.ts:117 — inline and delete the export**
  evidence: packages/extension/src/frontend/ui/dialogs.ts:90-95 selectFile is exactly `selectFiles({...options, allowMany: false})` + `paths?.[0] ?? null`; repo-wide grep shows the only non-test consumer is packa
  fix: Owner: commands/files. Inline the two lines at fileSelectionCommands.ts:117 and delete the selectFile export from dialogs.ts (note: this duplicates a batch-5 lead — one owner should take it).
- **DUPLICATE DIVERGENT REGISTRY: two monacoLanguageForPath implementations with disjoint language coverage**
  evidence: packages/extension/src/progressView/frontend/components/monacoLanguage.ts:7-41 (table-driven; has mdx/scss/less/sql/php/ruby/csharp, LACKS tex/bib/lean — so .tex diffs in ToolEditRequestPanel.ts:144 r
  fix: Owner: src/shared/monaco. Extract a pure mapping module (e.g. src/shared/monaco/monacoLanguages.ts — no monaco runtime import, mirroring the existing languageForPath helper shape) holding the UNION of both maps plus the
- **version.ts hand-rolls isCliOutputFormat/parseVersionOutputFormat duplicating cliContext.ts's private pickEnum; unify only if warning-silence and no-config-load semantics preserved**
  evidence: Duplication is real: packages/cli/src/commands/version.ts:14-25 re-implements enum-pick (flag -> TEXRA_OUTPUT_FORMAT env -> 'text') that packages/cli/src/runtime/cliContext.ts:309-323 (pickEnum: candi
  fix: Owner: cli runtime. Export pickEnum from cliContext.ts (gains its required second consumer in the same PR), rewrite version.ts's parseVersionOutputFormat as pickEnum([flagString, cliEnvValue('TEXRA_OUTPUT_FORMAT')], CLI_
- **unsupportedCommands JSDoc block duplicated near-verbatim in AgentsTab/GitTab/HistoryTab + StreamHeader; @shared/utils/dispatcher could own canonical doc**
  evidence: Near-identical 5-6 line blocks at settingsView/frontend/tabs/AgentsTab.ts:84-90, GitTab.ts:179-184, HistoryTab.ts:33-39, progressView/frontend/components/StreamHeader.ts:326-331
  fix: Comment-only: keep one canonical block on the dispatcher's unsupportedCommands declaration and replace the four copies with a one-line @see pointer. Trivial, one element-neutral edit per file.
- **Duplicate '// Third-party imports' banner comment twice per file in both openai handler files**
  evidence: modelHandlerOpenAI.ts:1 and :83; modelHandlerOpenAIResponse.ts:1 and :110 — second banner heads a third-party type-import block after the local-import section
  fix: Cosmetic comment-polish: merge the type imports into the top banner block or drop the second banner. 4-line comment-only edit.
- **packages/agent entry points have zero in-repo consumers; export lists are the Tier-1 trimming target**
  evidence: Duplicate of the earlier @texra-ai/agent lead, same verification: zero references outside packages/agent; CLAUDE.md documents the Tier-1 manifest as the pending decision.
  fix: Same as the twin lead: explicit Tier-1 manifest decision per CLAUDE.md; not a knip-style deletion pass.
- **XaiSubscriptionPreferenceUpdate alias — two CLI consumers could import SubscriptionPreferenceUpdate from src/model/subscriptionPreference directly**
  evidence: src/model/xai/xaiPreference.ts:16 alias (codex twin at codexPreference.ts:17); consumers packages/cli/src/chat/tui/state/xaiSubscription.ts:3 and packages/cli/src/runtime/grokLogin.ts:9 (codex: codexS
  fix: Owner: model layer + CLI. Re-point the 4 type imports to '@model/subscriptionPreference' (SubscriptionPreferenceUpdate), delete both alias lines. Type-only edits, −2 exported elements; do the codex twin in the same PR.
- **runPack single-caller pass-through; collapse per cleanCommands precedent (duplicate of previous lead)**
  evidence: Same finding filed twice: src/housekeeping/pack.ts:167-177, sole caller packCommands.ts:59, precedent cleanCommands.ts:54-58.
  fix: Same fix as the runPack lead above — one PR covers both entries

## Wave D — inlines, ownership, misc structural (36)

- **childExecutionKey is a trivial pass-through (`return child.childStreamId`) with exactly one production caller (streamViews.ts:115) — inline and delete the export**
  evidence: packages/cli/src/chat/tui/state/childExecutions.ts:568 (`return child.childStreamId;`); sole prod caller packages/cli/src/chat/tui/state/streamViews.ts:115; grep across packages+src+test-kernel shows
  fix: streamViews owner: replace `childExecutionKey(entry) === streamId` with `entry.childStreamId === streamId`, drop the import, delete the export in childExecutions.ts. ~3 lines net-negative.
- **agents.ts:80 re-declares AGENT_CATEGORIES locally instead of importing the SSOT from src/shared/schemas/agent.ts**
  evidence: packages/cli/src/runtime/agents.ts:80-83 declares the identical two-element tuple exported at src/shared/schemas/agent.ts:19-22 (same order, same values). Import precedent exists: packages/cli/src/run
  fix: CLI runtime owner — replace the local const with an import of AGENT_CATEGORIES from '@shared/schemas' (agents.ts:304 is the only use). No ratchet impact: @shared/schemas is already imported by sibling CLI modules. −3 lin
- **isCliLoginProvider is a pure pass-through to isOAuthProvider with exactly 2 callers; inline and delete**
  evidence: packages/cli/src/runtime/loginOptions.ts:73-77 body is `return isOAuthProvider(provider)`. Callers: same-file loginOptions.ts:162 and packages/cli/src/commands/auth.ts:143 (auth.ts already imports DEF
  fix: CLI runtime/commands owner — call isOAuthProvider directly at both sites (type-predicate signature is identical), delete the wrapper. No ratchet impact; @auth/config import already present in both files' module graph. −1
- **cliMultiAgentPresetListRecords has exactly one production caller; inline plans.map(cliMultiAgentPresetListRecord) and delete the wrapper**
  evidence: packages/cli/src/runtime/multiAgentPresets.ts:253-257 body is `plans.map(cliMultiAgentPresetListRecord)`; sole caller commands/multiAgent.ts:100 (import at :19); zero test-kernel imports. The singular
  fix: CLI runtime owner — write `plans.map(cliMultiAgentPresetListRecord)` at multiAgent.ts:100, delete the plural wrapper. −1 export, −4 lines.
- **secretManager.ts ApiProviderQuickPickItem interface is not exported, forcing the Awaited<ReturnType<...>>[number] chain in apiKeyCommands.ts**
  evidence: packages/extension/src/frontend/secretManager.ts:19 declares `interface ApiProviderQuickPickItem` with no export keyword; packages/extension/src/commands/api/apiKeyCommands.ts:109-112 derives `type Pr
fix: Owner: extension frontend/api-commands. Add `export` to the interface at secretManager.ts:19 and replace the Awaited<ReturnType> chain in apiKeyCommands.ts with a direct type import. ~2 lines, element-neutral type tighte
- **sharedStorageRoot.ts is the sole production consumer of legacyDataMigration.ts; both retire together when the storageUri migration window closes**
  evidence: Repo-wide grep: only packages/extension/src/frontend/vscode/sharedStorageRoot.ts:26 imports '@platform/defaults/legacyDataMigration' in prod (other hits are test-kernel vitest files); migrateLegacyVsc
  fix: Retirement-ledger entry, not an edit: when the context.storageUri/globalStorageUri migration window is ruled closed (cf. #7987/#8622 and the disposable-intermediate-data ruling), delete src/platform/defaults/legacyDataMi
- **SessionEventHub.subscribe keeps the callback union-typed even when filter.scope is supplied, forcing every run-scope consumer to re-narrow in-callback**
  evidence: src/agent/runtime/SessionEventHub.ts:76 (SessionEventSubscriber = (event: SessionEvent) => void) and 126-135 (untyped subscribe). Consumers re-narrow with runtime checks plus unsafe casts: packages/cl
  fix: Owner: src/agent/runtime/SessionEventHub.ts + ~6 consumer files. Add scope-keyed overloads on subscribe (filter literal 'run' narrows the callback to Extract<SessionEvent,{scope:'run'}>) or typed subscribeRunFacts/subscr
- **hasAnyUsableSetupCredential is a 1-line delegate to hasUsableSetupCredential(platform().secrets) with 3 callers in extension.ts/MainViewProvider.ts; lead punted citing ratchet-widening risk**
  evidence: packages/extension/src/commands/setup/setupAssistantCommand.ts:82-84 is exactly `return hasUsableSetupCredential(platform().secrets)`. External callers: extension.ts:129, extension.ts:339, MainViewPro
  fix: Owner: extension setup wiring. Inline hasUsableSetupCredential(platform().secrets) at the 5 call sites (extension.ts x2, MainViewProvider.ts x1, setupAssistantCommand.ts x2), delete the wrapper + export, and move the CLI
- **StreamingAggregator is a derived Pick of the only implementation; if createStreamingAggregator (single definition, no overrides) is inlined, the alias can be deleted and the class type used directly**
  evidence: grep over src/ and packages/ shows exactly one definition of createStreamingAggregator (src/agent/modelHandlers/openai/modelHandlerOpenAI.ts:243, docstring 'Allows subclasses to provide a streaming ag
  fix: modelHandlers/openai owner: inline the 8-line factory body into the line-410 call site, retype the `aggregator` param at line 536 as BaseReasoningStreamAggregator | null, delete the StreamingAggregator Pick alias and its
- **Unexport micro-sweep: MediaKind (mediaClassification.ts), ViewBundle/PanelOptions/MessageHandlerOptions (extension common/webview) are exported but referenced only inside their own files**
  evidence: Repo-wide grep: MediaKind appears only in src/agent/modelHandlers/support/mediaClassification.ts:21 and the packages/agent dist .d.ts (build artifact) — external callers (modelHandlerAnthropic.ts:1210
  fix: extension + modelHandlers owners: drop the `export` keyword on all four type declarations (MediaKind can stay non-exported as classifyMediaEntry's inferred return type). Trivial; batch with the knip dead-export sweep as
- **desktopViewStateIpc.ts exports `DesktopTheme = DesktopThemeKind` alias consumed only by mainViewIpc.ts; one-line canonicalization**
  evidence: packages/desktop/src/main/desktopViewStateIpc.ts:15 `export type DesktopTheme = DesktopThemeKind;` — grep across packages/desktop/src and src/test-kernel shows exactly one consumer: packages/desktop/s
  fix: Owner: desktop host. mainViewIpc.ts imports DesktopThemeKind from @shared/schemas/commonViewMessages and uses it at line 31; delete desktopViewStateIpc.ts:15. −1 export, 2-line edit.
- **ModelProviderFlags (userVars.ts) and SaveDebugParams (debugMessageSaver.ts) are exported with zero importers anywhere**
  evidence: grep over src/ + packages/ (incl. src/test-kernel, dist excluded): ModelProviderFlags appears only at src/agent/utils/userVars.ts:128 (def), :163, :221 (internal use); SaveDebugParams only at src/agen
  fix: Owner: agent/utils. Drop the `export` keyword on both interfaces (structural typing means buildUserVars/saveDebug callers are unaffected). Two one-word deletions; knip baseline needs no update since neither is listed.
- **UsageMonitorMetadata/UsageMonitorModelInfo/UsageMonitorContext exported but referenced only inside UsageMonitor.ts**
  evidence: grep over src/ + packages/ (dist excluded): all three names appear only in src/agent/utils/UsageMonitor.ts — defs at :46, :60, :87; uses at :111, :112, :120. Zero external importers incl. test-kernel;
  fix: Owner: agent/utils. Drop `export` on the three interfaces in src/agent/utils/UsageMonitor.ts (constructor param types remain structurally satisfied at external construction sites). Three one-word deletions.
- **RetryableInvocationNode has exactly one production subclass (ModelInvocationNode); merging base into subclass would delete a layer, but the test-kernel ExposedRetryNode harness subclasses the base directly**
  evidence: src/agent/core/flows/RetryState.ts:116 (class def); src/agent/core/flows/ModelInvocationNode.ts:73 is the only production `extends RetryableInvocationNode` (full-repo grep); src/test-kernel/agent/runt
  fix: Owner: agent-core flows + test-kernel, one PR. Fold the retry machinery (~440 lines: invokeWithRelayRecovery, retryPrompt, getFallbackResult, lifecycle logging) into ModelInvocationNode, keeping InvocationResult/handleIn
- **formatLineCount in src/shared/utils/string.ts has a single production caller (MemoryItem.ts:161); inline as formatResultCount(count, 'line') and delete the wrapper**
  evidence: src/shared/utils/string.ts:43-45 (trivial pass-through to formatResultCount); full-repo grep shows the only prod consumer is packages/extension/src/settingsView/frontend/components/memory/MemoryItem.t
  fix: Owner: extension settingsView webview. In MemoryItem.ts:161 replace formatLineCount(item.lineCount) with formatResultCount(item.lineCount, 'line'), add `import { formatResultCount } from '@utils/text/stringUtils'` (prece
- **Inline formatLineCount into its single caller MemoryItem.ts as formatResultCount(count, 'line'); deletes one exported element from @shared/utils/string**
  evidence: Duplicate of lead 1, same verification: src/shared/utils/string.ts:43-45 wrapper; single prod consumer packages/extension/src/settingsView/frontend/components/memory/MemoryItem.ts:161; no test referen
  fix: Same as lead 1 — one fix covers both leads: inline formatResultCount(item.lineCount, 'line') at MemoryItem.ts:161 with an @utils/text/stringUtils import, delete the wrapper and its import line in string.ts. −1 exported e
- **toolUseMarginBottomRows (toolRenderers.tsx:493) has 2 production callers — keep, don't collapse**
  evidence: packages/cli/src/chat/tui/panes/toolRenderers.tsx:493 defined; consumed at transcriptEntryLayout.ts:288 and ToolUseRow.tsx:139 — exactly the claimed 2-caller seam
  fix: No action. Accurate keep-note.
- **Relocation hazard: test-kernel references InstructionPanel/LatexDiffsSection via @webview alias and OnboardingWelcomeCard by literal repo path**
  evidence: src/test-kernel/webview/mainViewTestUtils.ts:40 `await import('@webview/frontend/components/InstructionPanel')`; LatexDiffsSectionActions.vitest.ts:28 dynamic alias import; DesktopControlSystem.vitest
  fix: No code change. Accurate hazard note — any rename of those components must grep string/alias references, not just symbol imports.
- **Two progressView PRDs still reference the deleted ProviderErrorSchema name**
  evidence: docs/prds/2026-01-24-prd-progressview-phase1.md:30 and 2026-01-24-prd-progressview-modernization.md:314 mention ProviderErrorSchema; zero code references repo-wide
  fix: Docs hygiene: fold a one-line name fix into whichever PR next touches those PRDs. Non-blocking.
- *_~26 src/tools *Input z.infer types exported with zero external consumers — one unexport PR*_
  evidence: Spot-verified all 26 named types: zero references outside their defining src/tools files (test-kernel included). Note: ZoteroSearchInput/ZoteroAddInput/ZoteroExportInput are already unexported at Zote
  fix: Drop the export keyword on the remaining ~23 types in one sweep PR (same edit as the already-landed zotero trio). Element-neutral but shrinks the frozen export surface; verify knip baseline stays green.
- **agentToolResolution.ts ResolvedAgentTools single-field wrapper pinned by three test-kernel suites destructuring { tools }; could return ToolDefinition[] directly**
  evidence: src/agent/runtime/agentToolResolution.ts:70-72 (`export interface ResolvedAgentTools { tools: ToolDefinition[] }`); sole prod caller destructures at src/agent/implementations/flows/tooluse/runToolUseF
  fix: Owner: agent runtime. Change resolveAgentTools return type to ToolDefinition[], update runToolUseFlow.ts:190 and the 3 test destructurings (DelegationAgentAvailability, DelegationWorktreeAvailability, ToolUseToolResoluti
- **outputValidation.ts ValidationResult — verify which fields OutputNode reads; potentially shrinkable**
  evidence: src/agent/output/outputValidation.ts:28-33 returns {storageKey, currRound, missing, xmlExists}; the sole consumer (src/agent/implementations/flows/reflection/nodes/OutputNode.ts:304-313) reads only va
  fix: Owner: agent output. Shrink checkExpectedOutputs to return { missing: string[] } (or string[]); xmlExists stays a local (used internally for reportMissingOutputs at outputValidation.ts:79); drop storageKey/currRound from
- **.nullish().transform((v) => v ?? default) idiom 10x in src/tools; add nullishDefault helper (not .prefault)**
  evidence: grep 'transform((v) => v ??' in src/tools returns exactly 10: grep.ts:33, CrossrefSearchTool.ts:28, WebSearchTool.ts:29, TexcountTool.ts:20, ArxivDownloadTool.ts:51,56, ArxivSearchTool.ts:39,52,58, Ar
  fix: Owner src/tools: add nullishDefault(inner, default) in a tool-schema util module preserving null-acceptance (.nullish().transform semantics, NOT .prefault); convert the 10 sites. Caveat Refactor-LOC lesson — verify net-n
- **@texra-ai/agent has zero in-repo consumers; Tier-1 public-manifest decision should be explicit**
  evidence: grep '@texra-ai/agent' across src+packages (excluding packages/agent itself) returns zero hits. CLAUDE.md explicitly names 'the Tier-1 public manifest' as the open work and holds npm publication until
  fix: Owner agent-SDK track: make the Tier-1 manifest decision per CLAUDE.md (explicit export list), not via knip dead-export deletion; this lead restates documented open work rather than adding a new finding.
- **latexdiffCommands.ts four pack/clean handlers differ only in label/wording/clean flag; parameterize ~60 lines**
  evidence: packages/extension/src/commands/latex/latexdiffCommands.ts:235-310 read: handlePackLatexdiffvc/handleCleanLatexdiffvc differ only in error text + clean:true hardcode; same for the Multiple pair. Clean
  fix: Owner packages/extension/src/commands/latex: parameterize on {verb: 'packing'|'cleaning', clean} for single and multiple variants (4 fns → 2); debug-log wording differs only incidentally — keep user-facing error strings
- **vscodeHostConfig.ts: all four exports have exactly one consumer (latexSettingsHandlers.ts, which imports vscode directly); inline and delete the 42-line module**
  evidence: packages/extension/src/frontend/vscode/vscodeHostConfig.ts:5,13,18,28 — four thin wrappers over vscode.workspace.getConfiguration(); sole consumer packages/extension/src/settingsView/handlers/latexSet
  fix: Owner: extension settingsView. Move the 4 wrappers into latexSettingsHandlers.ts as module-local functions (getConfig/getGlobalValue/isExplicitlySet/update), delete vscodeHostConfig.ts and the 5-line import. Net ~-15 lin
- **gitAuthorSetup.ts readGitAuthorSettings wrapper has zero value callers; only a type-level ReturnType use in SettingsViewMessageHandler.ts:680**
  evidence: packages/extension/src/frontend/git/gitAuthorSetup.ts:16-18 (wrapper) — the only value call is internal at :22; packages/extension/src/settingsView/SettingsViewMessageHandler.ts:680 uses ReturnType<ty
  fix: Owner: extension frontend/settingsView. Delete readGitAuthorSettings; inline readGitAuthorSettingsFromState(workspaceSM) into applyGitAuthorConfig; retype SettingsViewMessageHandler.ts:680 to GitAuthorSettings (or Return
- **externalToolDefs.ts:485 interpolates PR_POLL_INTERVAL_MS/MAX_CONCURRENT_PR_SUBSCRIPTIONS while githubSubscriptionTool.ts:505 hardcodes the same caps as prose — drift risk, shared constants owner wanted**
  evidence: src/tools/github/githubSubscriptionTool.ts:505 hardcodes '10 concurrent issue subscriptions, 3 concurrent repo subscriptions... Poll interval ≈ 30s' — but the enforced caps live as literals: IssuePoll
  fix: Owner: tools/github. Hoist ISSUE/REPO maxConcurrent + the shared 30s poll interval into the constants module (rename prSubscriptionConstants.ts → subscriptionConstants.ts), consume them in both polling sources, and inter
- **LatexdiffExecutionResult de-export (runLatexdiff.ts) — safe if the packages/agent declaration build tolerates a non-exported return-type interface**
  evidence: src/latex/latexdiff/runLatexdiff.ts:74-79 — zero importers anywhere (grep over src+packages+test-kernel); callers destructure structurally (desktopProgressFileActions.ts:220 'const { outcome } = await
  fix: Owner: latex/latexdiff. Delete the 'export' keyword at runLatexdiff.ts:74. No consumer changes. Verify with the normal typecheck gate.
- **Post-#9828, XaiSignedInProbe/CodexSignedInProbe type aliases become deletable once callers import SignedInProbe directly**
  evidence: src/model/xai/xaiSignedIn.ts:8 `export type XaiSignedInProbe = SignedInProbe` and src/model/codex/codexSignedIn.ts:9 twin; grep shows zero external type consumers — the only external imports are the s
  fix: Owner: model layer. Delete both alias lines and use SignedInProbe directly in the setXaiSignedInProbe/setCodexSignedInProbe signatures. −2 exported elements, no caller edits needed.
- **src/auth/constants.ts header cites stale circular-dependency rationale (authCommands.ts may no longer exist)**
  evidence: src/auth/constants.ts:1-5 says 'Separated from authCommands.ts to avoid circular dependencies. SettingsViewMessageHandler needs AUTH_COMMANDS but authCommands needs settings' — but src/auth/authComman
  fix: auth owner: doc-only fix — replace the 3-line header with the current rationale (shared command-ID constants consumed by tools + hosts). No element deletion
- **listOpenThreads is a 4-line wrapper with one prod caller; inline as listThreadsByStatus({status:'open',scope:'all'})**
  evidence: src/tools/inquiry/externalInquiryStorage.ts:717-721 (pure delegation); sole prod caller src/controllers/progressView/backend/ExternalInquiryRequestHandler.ts:62; tests call it directly (InquiryStorage
  fix: Owner: controllers+tools pair. Replace the call with listThreadsByStatus({status:'open',scope:'all'}), delete the export, migrate the 4 direct test call sites. ~5 net lines. Note sibling listOpenThreadsForStream has a re
- **src/common/schemas.ts (36 lines) has one consumer (texTools.ts); fold LaTeXCompileOptionsSchema in and delete the module**
  evidence: src/common/schemas.ts:17,35; only importer in repo is src/latex/texTools.ts:6-7 (packages/agent/dist hit is build output)
  fix: Owner: src/latex. Move schema + type into texTools.ts, delete src/common/schemas.ts. One file deleted, no new exports.
- **countOccurrences has one prod caller (fileEditFlow.ts); move it there and delete from shared utils**
  evidence: src/tools/utils.ts:9; only prod importer src/tools/fileEditFlow.ts:11, use at :172; no test-kernel imports
  fix: Owner: src/tools. Move the ~8-line function into fileEditFlow.ts as module-private, delete from utils.ts. One export removed, no test edits.
- **toolSections.ts:273 re-implements executionsAction inline without .trim(); drift bug or intentional divergence**
  evidence: packages/extension/src/progressView/frontend/formatters/logFormatters/toolFormatters/toolSections.ts:273 `asString(input.action) ?? EXECUTIONS_DEFAULT_ACTION` vs canonical src/shared/tools/executionsD
  fix: Owner: extension progressView frontend. Replace line 273 with executionsAction(input) — drop-in type-compatible. Fixes a real edge (action ' wait ' or '' misrendered) and deletes the divergent re-implementation. ~2 lines

## Wave E — stale comments / docs (3)

- **useSignal.ts doc comment narrates implementation details ('the cleanup below only calls watcher.unwatch(signal)', 'disposed is scoped to this one subscribe() invocation') that now live in signalSubscription.ts — stale…**
  evidence: packages/cli/src/chat/tui/state/useSignal.ts:39-47 comment says 'the cleanup below' but there is no cleanup in this file — the watcher/disposed logic lives in packages/cli/src/chat/tui/state/signalSub
  fix: useSignal owner: retarget the last two comment paragraphs to describe the contract subscribeToSignalChanges provides (microtask-deferred notify, disposed-guard) rather than 'below' mechanics. Cosmetic, comment-only edit.
- **hasUsableApiKey/apiKeyExists are behaviorally identical (resolveApiKeyUncached trims + rejects empty); collapse to one export across 5 files**
  evidence: src/model/apiProviders.ts:160-177 — apiKeyExists is '(await lookupApiKey(...)) !== undefined', hasUsableApiKey is 'isNonEmptyString(await lookupApiKey(...))'; lookupApiKey's value comes from resolveAp
  fix: Owner: model + tools/setup + 3 hosts. Keep apiKeyExists; delete hasUsableApiKey from apiProviders.ts and from the SetupPlatform port (src/tools/setup/platform.ts:43,159-160); switch UnsetApiKeyTool.ts:51,74 to apiKeyExis
- **isWSL() wrapper (wslDetect.ts) could become a direct is-wsl import at its 2 call sites**
  evidence: src/utils/system/wslDetect.ts:21-23 — one-line wrapper over the is-wsl default export whose stated rationale is 'existing call sites stay unchanged' (a compat shim, not logic). Exactly 2 call sites: s
  fix: Owner: utils/system. Import isWsl from 'is-wsl' at both call sites (keep one comment noting is-wsl's container exclusion), delete wslDetect.ts. -1 file, ~-20 lines.
