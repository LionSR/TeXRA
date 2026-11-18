# TT: app tools, LaTeX and replacement (`packages/texra/src/tools/`, `latex/`, `replacement/`)

Read on `main` at `d70ad92` (worktree head `93906b9`, which adds only the
brief). Read-only.

## Numbers

| Directory                 | Lines (`.ts`) |
| ------------------------- | ------------: |
| `tools/` (root files)     |          1444 |
| `tools/github/`           |          4064 |
| `tools/agentCli/`         |          3509 |
| `tools/lean/` + `direct/` |          2551 |
| `tools/documents/`        |          1839 |
| `tools/zotero/`           |          1290 |
| `tools/setup/`            |          1215 |
| `tools/inquiry/`          |           964 |
| `tools/latex/`            |           878 |
| `tools/arxiv/`            |           432 |
| `tools/comment/`          |           321 |
| `tools/media/`            |           272 |
| `tools/approval/`         |           127 |
| `tools/userQuestion/`     |           112 |
| `latex/` (root files)     |          4067 |
| `latex/latexdiff/`        |           515 |
| `latex/formatter/`        |           435 |
| `replacement/`            |          2940 |
| **total**                 |     **26975** |

Five largest files: `replacement/rules.ts` (772), `latex/arxivProcessor.ts`
(743), `tools/lean/direct/leanServer.ts` (685), `replacement/maxRules.ts`
(644), `tools/documents/documentTools.ts` (576).

Earlier coverage of this area: round 2's H (`tools/`, mostly GitHub, Lean,
Zotero) and I (`latex/`, documents, `replacement/`), all landed or settled
except H9 (held with #14773). This report reads the parts those rounds read
least (agent CLIs, setup, inquiry, media, the tool root files, the LaTeX
extractors) and re-reads the rest for regressions.

Note on API checks: `node_modules` is not installed in this checkout, so no
Effect signature below was read from `node_modules/effect`; where a finding
leans on an Effect API it cites a call already in the tree that uses it.

---

## TT-1: An inquiry request says which turn it opens four ways, and copies its last turn beside the transcript that holds it

- flags: information leakage, non-obvious code, comment restates code
- package: texra (`tools/inquiry/`, `shared/plugins/externalInquiry.ts`,
  `ui/progress/components/ExternalInquiryPanel.ts`)
- kind: refactor (a request payload's stored shape changes: "Needs your eye")
- size: S
- earlier: none (the lens-2 row on `markDropped`'s `null`,
  `../2026-11-08-design-red-flags-lenses-2/README.md:205`, is the record
  service's return, since replaced by `InquiryTurnOutcome`; this is the
  request payload)
- open PR: none

**Evidence.** `InquiryRequestSchema` (`shared/plugins/externalInquiry.ts:85-97`)
carries the thread's turns as an optional, nullable `transcript` (`:94-96`)
and, beside it, `question`, `context`, `suggestSearch`, `attachFiles`
(`:88-92`), which are the last turn's own fields (`InquiryTurnBaseShape`,
`:48-55`), and `sessionLinks` (`:93`), which the writer derives from the
same turns (`collectKnownSessionLinks`, `tools/inquiry/ExternalInquiryTool.ts:129-142`).
The one writer always sets `transcript: manifest.turns`
(`ExternalInquiryTool.ts:285`), and `recordOpenQuestion` always returns a
record whose last turn is the open one (`inquiryRecords.ts:143-147`), yet
"which turn this request opens" is read four ways:

- the request id grammar, `<thread>` for turn 1 and `<thread>:<turn>` after
  (`ExternalInquiryTool.ts:271-275`), with `turns.at(-1)?.turnIndex ?? 1`;
- the decision's `permission.transcript?.at(-1)?.turnIndex ?? 1`
  (`inquiryActions.ts:125`), whose `?? 1` answers turn 1 for a payload
  with no transcript instead of failing;
- the panel's draft key `${threadId}#${transcript?.length ?? 0}`
  (`ui/progress/components/ExternalInquiryPanel.ts:49-51`), counted by
  length, not by `turnIndex`, under a comment that calls it "the number of
  turns already answered" (`:47-48`) although the open turn is counted;
- the panel's "follow-up" label, `transcript?.length > 1` (`:153`).

The schema's comment says first and follow-up turns are "told apart by
`transcript`" (`:81-84`), which is the protocol the struct should carry.

**The design decision behind it.** Which turn of which thread a request
opens. Nothing owns it, so each reader recovers it from the transcript's
shape, and two of them default it when the transcript is missing.

**The better design.** The request carries `turnIndex` (required) and a
required `transcript`; `question`, `context`, `suggestSearch` and
`attachFiles` are read from `transcript.at(-1)` by the panel, or the
transcript drops its last turn and the request keeps the open turn's fields
as the one copy (either works; one of the two goes). The request id is
built from `turnIndex` in one function next to the schema, which the
decision and `deliveryId` (`inquiryActions.ts:203`) use. Deleted: the two
`?? 1` defaults, the `?? 0`/`> 1` length reads, the "told apart" comment,
and `sessionLinks` on the request (the panel derives it from the
transcript with the function the tool now holds). Callers write
`inquiry.turnIndex`.

**What we give up, and risk.** A request row written before the change no
longer decodes; inquiries open across the upgrade are lost from the panel.
Before 1.0 that is allowed; it is a stored-shape change.

**How I tried to refute it.** Looked for a reader that needs the copied
fields without the transcript: the CLI has no inquiry surface
(`grep -rln InquiryRequest packages/*/src` lists only the four files
above). Checked whether `transcript` can be absent in practice: only one
writer, which always sets it. Checked whether the length and the index can
differ: `turnIndex` is `turns.length + 1` at write (`inquiryRecords.ts:143`),
so today they agree, which is why nothing has broken; the readers still
disagree on what they count.

---

## TT-2: `open_pdf` is offered on every host and fails on the two that have no PDF viewer, while its sibling `diagnostics` is gated on the same registry

- flags: special-general mixed, non-obvious code
- package: texra (`tools/editorHost.ts`, `tools/OpenPdfTool.ts`,
  `tools/registry.ts`)
- kind: bug
- size: S
- earlier: H9 (round 2, held) names the three ways `HostCapabilities` is
  produced and proposes deriving them from presence; it does not list this
  defect. This finding is the one-capability fix that stands alone, or
  rides H9 when it is scheduled.
- open PR: none

**Evidence.** The editor registry holds three optional members,
`readDiagnostics`, `addCriticism`, `openPdf` (`tools/editorHost.ts:60-76`),
but serves exactly one capability name: `EditorCapability = 'diagnostics'`
(`:79`) and `of` returns `['diagnostics']` from the presence of
`readDiagnostics` alone (`:120-123`). So `diagnostics` is offered only
while an editor that reads diagnostics is attached
(`DiagnosticsTool.ts:199`), but `OpenPdfTool` declares no `hostCapability`
and sits in the always-on `core` plugin (`registry.ts:223-233`). Only the
VS Code window attaches an `openPdf` (`packages/extension/src/progressView/ProgressViewProvider.ts:192`);
the desktop and CLI attach none (no `openPdf` in `packages/desktop/src` or
`packages/cli/src`). On those hosts every run is offered `open_pdf`, and
every call fails with "open_pdf is not available in this host"
(`OpenPdfTool.ts:55-60`). The editor header says the registry's point is
that a tool "is offered exactly while an implementation is attached"
(`editorHost.ts:7-9`); that holds for one of its three members.

**The design decision behind it.** Which editor members a tool may be
offered for. `of` answers it with a hand-written special case for one
member, so each new member is ungated until someone adds a branch.

**The better design.** `of` derives the names from the attached members,
as the setup plugin already does over its platform record
(`registry.ts:279-282`): `Object.entries(at(storage))` with a defined value.
`EditorCapability` becomes `keyof EditorCapabilities`; `DiagnosticsTool`
declares `'readDiagnostics'`, `OpenPdfTool` declares `'openPdf'` and moves
from `core` to the plugin that serves `EditorHost` as `HostCapabilities`
(`latexDiagnostics`, `registry.ts:195-213`), or `core` serves the registry
as its capabilities too. The in-body `if (!openPdf)` checks stay: the
capability is read per step and a window can detach mid-call. Deleted: the
`'diagnostics'` literal and the `readDiagnostics ? [...] : []` branch.

**What we give up, and risk.** The `diagnostics` capability name changes
spelling (a runtime string, not persisted). A run on desktop no longer
sees `open_pdf`; that is the point.

**How I tried to refute it.** Looked for a desktop or CLI PDF opener
reached another way (`grep -rn openPdf packages/*/src`): only the VS Code
provider and the service-window relay (`controllers/server/hostWindows.ts:253-262`),
which forwards a VS Code window's offer. Checked whether `core`'s tools
are meant to be host-independent: its doc says "Tools every host offers
without setup" (`registry.ts:217-222`), which `open_pdf` is not.

---

## TT-3: `extract_tikz_figures` compiles by default on some providers and never on others

- flags: non-obvious code
- package: texra (`tools/latex/ExtractTikzFiguresTool.ts`)
- kind: bug
- size: S
- earlier: none
- open PR: none

**Evidence.** The input declares `compile` as
`Schema.optional(Schema.NullOr(Schema.Boolean))` (`ExtractTikzFiguresTool.ts:26-33`),
and the body defaults it by destructuring, `compile = true`
(`:40-43`). A destructuring default applies only to `undefined`. The
OpenAI-compatible providers fill every advertised optional field with
`null` (root `AGENTS.md` "Tool input schemas"; `packages/harness/AGENTS.md`
"Tool input schemas"), so on those providers an omitted `compile` arrives
as `null`, `if (compile)` (`:72`) is false, and nothing is compiled; on
Anthropic it is omitted and everything is compiled. The description does
not say what the default is (`:121`).

**The design decision behind it.** Where a tool input's default lives. The
harness has the one answer, `nullishWithDefault`
(`packages/harness/src/tools/core/inputSchema.ts`, used by
`SendToTerminalTool.ts:34-44`, `OpenPdfTool.ts:38-42`), which also puts
the default in the model's JSON Schema; this tool bypasses it.

**The better design.** `compile: nullishWithDefault(Schema.Boolean, true,
'Compile extracted TikZ pictures into standalone PDFs. Defaults to true.')`
and a plain `compile` in the body.

**What we give up, and risk.** Nothing; OpenAI-routed runs start
compiling (and spending a LaTeX build) where they silently did not.

**How I tried to refute it.** Grepped every tool body in
`packages/*/src/tools` for a destructuring default over its input: this is
the only one. Checked that `defineTool` does not normalize `null` to
`undefined` before `execute` (`packages/harness/src/tools/core/definition.ts:86-105`
decodes with the schema and passes the result through).

---

## TT-4: Setup and inquiry tools check closed choices in the body and restate their tables in prose; one description has already drifted

- flags: repetition, information leakage, comment restates code
- package: texra (`tools/setup/`, `tools/inquiry/`)
- kind: refactor (one drifted description is a docs-level bug)
- size: S
- earlier: none (round 5's tests report cites `assertInSetupAllowlist`
  only as a test target, `../2026-11-07-design-red-flags-round-5-tests/3-cannot-fail.md:67`)
- open PR: #14953 touches `InstallVscodeExtensionTool.ts`,
  `InvokeCommandTool.ts`, `UnsetApiKeyTool.ts` and `ExternalInquiryTool.ts`
  with a one-line `Schema.NonEmptyString` swap each (its diff for those
  paths); none of this.

**Evidence.** Four tools take a value from a closed set the code already
holds, declare it as an open string, and check membership in the body:

- `invoke_command`: `command: Schema.NonEmptyString`
  (`setup/InvokeCommandTool.ts:48`), checked against `ALLOWED_COMMANDS`
  (`:42-45`) by `assertInSetupAllowlist` (`:68`). Its description spells the
  allowlist out by hand (`:99`) and has drifted: `texra.openGettingStarted`,
  `texra.removeApiKey` and `texra.showMainView` are allowed
  (`:25,29,35`) but never offered to the model.
- `install_vscode_extension`: `extensionId: Schema.NonEmptyString`
  (`InstallVscodeExtensionTool.ts:34`), checked against
  `ALLOWED_EXTENSIONS` (`:22-25`, `:47`); the description restates the two
  ids (`:101`).
- `unset_api_key`: `provider: Schema.NonEmptyString`
  (`UnsetApiKeyTool.ts:22`), checked by `isApiProvider` (`:34-39`) with a
  hand-built "Supported:" list.
- `apply_team`: `teamId: Schema.String` with a `makeFilter` over `TEAM_IDS`
  (`ApplyTeamTool.ts:40-45`), then a body branch for an unknown id
  (`:62-70`) that its own comment says only fires "if the enum and the
  preset list ever disagree", which they cannot, being one list.

`update_config` in the same directory does it the other way:
`key: Schema.Literals(UPDATABLE_KEY_LIST)` (`ConfigTools.ts:92`), so the
model sees the enum and the decode rejects anything else.

The inquiry tool's description states "Q is truncated to 400 chars and its
A to 2000 chars" (`inquiry/ExternalInquiryTool.ts:221`), while the numbers
live as `QUESTION_TRUNCATION`/`ANSWER_TRUNCATION` in another file
(`inquiry/inquiryActions.ts:39-40`). `packages/harness/AGENTS.md`
"Tool input schemas" asks that a description that enumerates dispatch
behavior stay in step with the dispatch table.

Two smaller copies in the same directory: `SubscriptionProbeFailed`'s
comment says it "stays `Promise`-shaped with the rest of the account
group" (`setup/platform.ts:115-119`), but `getStatus()` returns an
`Effect` (`packages/llm/src/oauth/subscriptionCoordinator.ts:79`) and the
probe is an `Effect.fn`; and its `member` literal (`:124`) is read by
nothing (`grep -rn '\.member\b' packages/texra/src` is empty).

**The design decision behind it.** Where a tool's closed choice is
declared: the schema (which the model reads as an `enum` and the decode
enforces) or the body (which the model learns about from prose).

**The better design.** `Schema.Literals(SETUP_INVOKABLE_COMMANDS ∪
LEAN4_SETUP_COMMANDS)`, `Schema.Literals([LATEX_WORKSHOP_EXT_ID,
LEAN4_EXTENSION_ID])`, `Schema.Literals(API_KEY_PROVIDER_IDS)` and
`Schema.Literals(TEAM_IDS)`; descriptions say what each group is for and
let the enum list the ids. Move the two truncation constants beside the
tool's description (or export them from `inquiryActions.ts`) and
interpolate them. Deleted: `assertInSetupAllowlist` (2 callers, both
here), `ALLOWED_COMMANDS`/`ALLOWED_EXTENSIONS` as `Set`s, the
`isApiProvider` branch, `apply_team`'s `'unknown'` branch, the hand-typed
id lists in two descriptions, the false comment and `member`.

**What we give up, and risk.** The bodies' `.trim()` tolerance of padded
ids goes; a model that pads an id gets a decode error naming the enum,
which is the better message. `applyTeam` keeps its `'unknown'` result for
its other caller (the settings action).

**How I tried to refute it.** Checked whether a literal enum is avoided
for a provider reason: `LspTools.ts:79,89,100`, `ArxivSearchTool.ts:101-107`
and `ConfigTools.ts:92` all send `Schema.Literals` to every provider.
Checked that `TEAM_IDS` and the preset list are one list
(`ApplyTeamTool.ts:28-29`). Checked the `check:fact-spread` rule
(`packages/harness/AGENTS.md:86`): each `Literals` reuses the existing
constant, so no new literal set is written.

---

## TT-5: The agent-CLI "shared" module is three steps each provider must chain in order, with the thread claim threaded through four calls and the card teardown left to each driver

- flags: temporal decomposition, pass-through, shallow module, repetition,
  vague name
- package: texra (`tools/agentCli/`)
- kind: refactor
- size: M
- earlier: TC7 (lens 1, `../2026-11-07-design-red-flags-lenses/temporal-conjoined.md:455-467`):
  `StreamedToolCards.failOpen` called by hand in both drivers, "open, no
  owner" in the catalogue (`catalogue.md:1555`) and still so:
  `claudeAgent.ts:228-232`, `codex.ts:319-324`. This finding is the larger
  shape TC7's item is one symptom of.
- open PR: #14953 touches `claudeAgent.ts` (a 4-line change); not this.

**Evidence.** `agentCliShared.ts` exports three functions, and each
provider calls all three, nested, in the same order:

1. `dispatchAgentCliTool` (`agentCliShared.ts:155-206`): refuses a
   one-shot run, takes the claim on the resumed thread, calls `launch(claim)`;
2. the provider's `launchClaudeAgentSession` / `launchCodexSession`
   (`claudeAgent.ts:438-510`, `codex.ts:464-501`) builds its options and
   calls `launchAgentCliSession` (`agentCliShared.ts:102-146`) with a `turn`
   callback;
3. that callback calls the provider's `buildClaudeAgentTurn` /
   `buildCodexTurn` (`claudeAgent.ts:343-379`, `codex.ts:336-366`), which
   call `buildAgentCliTurn` (`agentCliShared.ts:238-290`).

The claim taken in step 1 is closed in step 3: it rides
`launch: (claim) =>` (`claudeAgent.ts:413-414`, `codex.ts:433`), the
provider's launch parameter (`claudeAgent.ts:444`, `codex.ts:467`), the
turn-builder's params (`claudeAgent.ts:348-350`, `codex.ts:341-342`) and
`buildAgentCliTurn`'s (`agentCliShared.ts:212`), read only at
`:276-278`. `launchAgentCliSession` takes eight parameters, four of them
wording: `registerFailedMessage`, `summaryLabel`, `launchedLine`,
`followUpLine` (`:84-95`), of which the follow-up line differs between the
two providers only in the id's name (`claudeAgent.ts:508`, `codex.ts:499`)
and the failure message is the summary label with a prefix
(`claudeAgent.ts:481`, `codex.ts:488`). The agent's name is passed twice
per call, to dispatch and to launch, and codex spells it two ways:
`CODEX_AGENT_NAME` (`codex.ts:429`) and the literal `'codex'` (`:485`).
The receipt prints the run id twice, `Run ID: ${runId}` and
`Run: ${runId}` (`agentCliShared.ts:140-141`), where every harness
launcher prints it once (`harness/src/tools/bash.ts:418`,
`agent/runtime/delegation/subagentRun.ts:169`,
`tools/codemode/backgroundScript.ts:38`). `isTurnError` and
`turnErrorMessage` are two optional functions that are both given or both
left out (`agentCliShared.ts:226-228`, `claudeAgent.ts:358-361`).

On teardown, `StreamedToolCards` says it holds the fail-if-open rule "in
one place" (`:36-39`) yet asks to be called "once when the turn tears
down" (`:74`); both drivers write that `ensuring` (TC7 above).

**The design decision behind it.** What a provider must supply to be an
agent CLI. The module answers it as three entry points split by when they
run (before launch, at launch, in the child), so each provider re-states
the sequence and carries the claim between them.

**The better design.** One exported `agentCliTool(provider)` that returns
the tool's `execute`: it refuses a one-shot run, takes and holds the claim
for the turn's life, launches the child, times the turn, logs usage,
closes the claim, and builds the receipt and the deliveries. A provider is
a record: `name`, `label` ("Codex", "Claude Code CLI"), `idField`
(`thread_id`, `session_id`), `resumeId(input)`, `prepare(input)` (an Effect
returning `modelRef`, a `launchedLine` and the provider's turn
`(logger) => Effect<{ response, usage, attributes, lines?, failure? }>`).
A turn the provider reports as failed returns `failure`, one field
instead of the optional pair. The card set is acquired in the turn's scope
(`Effect.acquireRelease`, release `failOpen`), as TC7 proposed. Deleted:
`dispatchAgentCliTool`, `launchAgentCliSession`, `buildAgentCliTurn` and
`AgentCliLaunchParams`/`AgentCliTurnParams` as exports (one entry
replaces them), `buildClaudeAgentTurn`, `buildCodexTurn`, the four wording
parameters, the second agent-name argument, the duplicate `Run:` line, and
both hand-written `ensuring` teardowns. Each provider file keeps only its
SDK stream and its options.

**What we give up, and risk.** The provider record is a small interface
of five members; a third provider would need nothing more. The risk is the
claim's masking (`agentCliShared.ts:186-205`), which must move whole into
the one entry; it is already written once.

**How I tried to refute it.** Looked for a third caller of any of the
three functions (none: `grep -rn "dispatchAgentCliTool\|launchAgentCliSession\|buildAgentCliTurn" packages/*/src`
gives only the two providers and the definitions). Checked whether codex's
throw-on-failure and Claude's error-turn need different shapes: Claude's
error turn carries cost lines into its error delivery
(`claudeAgent.ts:372-378`), which a `failure` field on the turn result
keeps. Checked whether the second `Run:` line is read by a parser
(`grep -rn "'Run: \|\`Run: "` finds no reader of the receipt).

---

## TT-6: `downloadArxivSource` takes "indent or not" as two parameters, its callers resolve the formatter for it, and "the root is never indented" is decided twice

- flags: conjoined methods, repetition, non-obvious code
- package: texra (`latex/arxivProcessor.ts`, `tools/arxiv/ArxivDownloadTool.ts`);
  touches extension (`commands/latex/arXivCommands.ts`)
- kind: refactor
- size: S
- earlier: none (I8, refused as `ARXIV-download-retry-cause-pair`, is the
  retry and cause wrapping; this is the options)
- open PR: none

**Evidence.** `DownloadSourceOptions` (`latex/arxivProcessor.ts:105-110`)
holds `formatter: LatexFormatter | null` and `autoIndent?: boolean`
(default `true`, `:421`). Both callers pass the same pair, written the same
way: `formatter: autoIndent ? yield* resolveLatexFormatter(roots) : null,
autoIndent` (`tools/arxiv/ArxivDownloadTool.ts:95-98`;
`packages/extension/src/commands/latex/arXivCommands.ts:101-104`). The
processor then indents only when `autoIndent && !isRoot` (`:455`), and
`indentLatexFilesInDirectory` independently skips a `null` formatter
(`formatter/indentDirectory.ts:73-78`); so "skip" is said by
`autoIndent: false`, by `formatter: null`, and by `destination: 'root'`.
The extension decides "root is never indented" a second time before
asking (`arXivCommands.ts:82-87`). The tool's schema says `autoIndent`
defaults to true (`ArxivDownloadTool.ts:68-72`) and does not say a root
download ignores it. Both callers also hand the workspace root as
`?? ''` (`ArxivDownloadTool.ts:86`, `arXivCommands.ts:100`), and the
processor reads the empty string back as "No workspace folder is open"
(`arxivProcessor.ts:435-438`).

**The design decision behind it.** Whether and how a download is
indented. The processor owns the "not the root" half and its callers own
the formatter half, so each caller restates both.

**The better design.** `downloadArxivSource(input, { roots, destination,
indent })`, where `indent: boolean` is the caller's wish and the processor
resolves `resolveLatexFormatter(roots)` itself and applies the root rule
once; `roots.workspace` undefined is the typed failure it is today, read
from the roots instead of from `''`. The extension asks the indent
question only for a references download, reading the rule from the
processor's exported destination type or a one-line predicate beside it.
Deleted: the `formatter` option, the two copies of the formatter
expression, the `autoIndent = true` default (the tool schema already
defaults it), and the two `?? ''` sentinels.

**What we give up, and risk.** `downloadArxivSource` gains the
`Settings` read it now gets from its callers; it already reads
`LatexProgress` from context, so it is not a pure function today.

**How I tried to refute it.** Looked for a caller that passes a formatter
other than the workspace's (`grep -rn "downloadArxivSource(" packages/*/src`):
two callers, both resolve from the same roots. Checked whether `null`
from `resolveLatexFormatter` (setting `none`) needs a distinct path: it
does, and `indentLatexFilesInDirectory` already handles it, so the
processor keeps passing what it resolves.

---

## TT-7: Four modules under `tools/` serve no tool: the approval preview and its temp files, the draft recorder, and the Pack destination

- flags: information leakage, vague name, shallow module
- package: texra (`tools/latex/latexPreview.ts`, `tools/approval/`,
  `tools/media/`, `tools/documents/runOutputs.ts` move to `controllers/`);
  touches desktop and extension imports
- kind: refactor
- size: S (moves and import edits; `runOutputs.ts` inlined)
- earlier: none on placement (I11 and the fallbacks report read
  `latexPreview.ts`'s behavior, not where it lives)
- open PR: none

**Evidence.** No file under `tools/`, `latex/` or `replacement/` imports
any of these four (`grep -rln "latexPreview\|tempFileManager\|media/audio\|runOutputs"`
over the three directories finds only `latexPreview.ts` itself). Their
consumers are controllers and hosts:

- `tools/latex/latexPreview.ts` (364 lines, "LaTeX preview and diff
  operations for tool edit approval", `:1-8`): `previewProposedLatex` and
  `runLatexdiff` are called only by
  `controllers/approval/ToolEditApprovalController.ts:57-58,264-270`; its
  `BuildDisplayFn` type is imported by three desktop files and the VS Code
  approval host (`desktopAgentRunHost.ts:4`, `desktopPreviewHost.ts:22`,
  `desktopToolEditApproval.ts:23`, `VscodeToolEditApprovalHost.ts:33`).
- `tools/approval/tempFileManager.ts` (127): written for the two hosts'
  diff views (`:1-17`), imported by `desktopToolEditApproval.ts:24` and
  `VscodeToolEditApprovalHost.ts:34-35`.
- `tools/media/audio.ts` (272): the sox recorder, imported only by
  `controllers/session/hostDraftRequests.ts:27`.
- `tools/documents/runOutputs.ts` (37): one function, `packDestination`,
  "where the toolbar's Pack puts a run's files" (`:1`), with one caller,
  `controllers/session/hostRunActions.ts:41,456`; a single-caller
  extraction in another layer's directory.

Root `AGENTS.md` "Where things go" puts host-neutral app orchestration in
`packages/texra/src/controllers/`. A reader looking for what a tool can do
finds the approval UI's PDF build and a microphone recorder beside the
tools; a reader of the approval controller finds half its implementation
in `tools/latex/`.

**The design decision behind it.** What `tools/` means. Today it means
"tools, and some host features that once sat near one", so its name
carries two meanings.

**The better design.** `tools/` holds plugins and their tools only.
`latexPreview.ts` and `tempFileManager.ts` move to
`controllers/approval/` beside the one controller they serve;
`audio.ts` moves to `controllers/session/` (or `controllers/media/`) beside
its one caller; `packDestination` is inlined into `hostRunActions.ts`, its
one caller, and `runOutputs.ts` is deleted. Hosts import from
`@texra/controllers/approval/...`. Nothing else changes.

**What we give up, and risk.** Import churn in six files; no behavior
change.

**How I tried to refute it.** Checked whether any of the four is a
plugin's dependency reached through a tool (none: no import from
`tools/`). Checked whether `controllers/` may import `latex/` (it does
already, e.g. `controllers/settingsView/LatexToolingController.ts`).
Checked that `latexPreview.ts` imports nothing from `tools/` itself (its
imports are harness, `@housekeeping/constants` and `@latex/*`).

---

## TT-8: The `latex/` README and the agent-CLI import headers state things the code no longer does

- flags: comment restates code (false comments)
- package: texra (`latex/README.md`, `tools/agentCli/codexImport.ts`,
  `tools/agentCli/claudeAgentImport.ts`)
- kind: docs
- size: S
- earlier: none for these lines (round 5's docs report,
  `../2026-11-07-design-red-flags-round-5-docs/REPORT.md`, did not read
  `latex/README.md`'s claims against the code)
- open PR: none

**Evidence.**

- `latex/README.md:18-20`: "Subprocesses spawn inside `Effect.tryPromise`,
  whose thunk gets a signal that aborts when the fiber is interrupted."
  The subprocess code goes through `ChildProcessSpawner` and
  `executeCommand` (`texcount.ts:8,90,179`; `latexdiff.ts:135`, "the
  fiber's own interruption: `executeCommand` kills it from its
  finalizer"); the one `Effect.tryPromise` left in the directory is the
  arXiv HTTP fetch (`arxivProcessor.ts:362`).
- `latex/README.md:30-32`: `latexToolchain.ts` is "the CLI tools TeXRA
  needs, type-checked against `@texra/shared/constants/latexToolchain`,
  which catches a removed tool but not a missing new one". The file is the
  `texra doctor` probe, `probeLatexToolchain` over `DOCTOR_LATEX_TOOLS`
  (`latexToolchain.ts:18-43`), with one caller
  (`packages/cli/src/runtime/doctor.ts:18,257`); the catalog is derived,
  so the "missing new one" caveat no longer applies.
- `latex/README.md:42-44` lists `criticismParser.ts` among this
  directory's extractors. It is `packages/extension/src/frontend/latex/criticismParser.ts`;
  there is no such file under `packages/texra/src/latex/`.
- `tools/agentCli/codexImport.ts:4-6`: "The SDK is bundled into CJS by
  esbuild at build time, so no runtime ESM/CJS workarounds are needed",
  while the function it describes goes through `importForeignSdk`, which
  exists to resolve "the ESM/CJS interop shapes esbuild can produce"
  (`vendorPackages.ts:8-10,72-77`); the same file's function comment (`:40-47`) says the import goes through that wrapper.
- `claudeAgentImport.ts:15` and `codexImport.ts:13-14`, and both resolver
  comments (`claudeAgentImport.ts:83-84`, `codexImport.ts:130-131`), say
  binary lookups are "cached for the session"; the cache is a module-level
  `SynchronizedRef` per resolver (`vendorPackages.ts:255`), which its
  own comment calls "process-lifetime" (`:12`, `:238`). In the CLI service one
  process serves many sessions, so "session" is wrong in the case where it
  matters.

**The design decision behind it.** None; these are comments left behind
by changes to the code they describe (the move to `ChildProcessSpawner`,
the derived tool catalog, the criticism parser's move to the extension).

**The better design.** Rewrite the three README sentences to what the
code does (or delete the cancellation sentence: interruption through the
spawner is the harness's rule, not this directory's); drop
`criticismParser.ts` from the list or name its real path; correct the
two import headers to "process lifetime" and delete the CJS sentence.

**What we give up, and risk.** Nothing.

**How I tried to refute it.** `find packages -name 'criticismParser*'`
gives only the extension's file. Read every `Effect.tryPromise` in
`latex/` (one). Read `latexToolchain.ts` whole (44 lines).

---

## TT-9: "Keep a found binary for the process, retry a miss" is written three ways, one of them a module singleton made at import

- flags: repetition, non-obvious code
- package: texra (`tools/agentCli/vendorPackages.ts`, `tools/agentCli/codexConfig.ts`;
  the model to follow is `utils/system/binaryResolver.ts`, TC's area)
- kind: refactor
- size: S
- earlier: G11h (round 2) moved `foundTools` and the package-manager map
  from module `let`s to process references, landed in #14874
  (`catalogue.md:224`). The agent-CLI resolver is the same fact written
  the way G11h removed: a remainder. The lane maps stay
  (`M7-file-lanes-as-references`, refused).
- open PR: none

**Evidence.** Three caches of a probed binary fact, each with its own
lifetime and its own answer to concurrent misses:

- `FoundTools` (`utils/system/binaryResolver.ts:51-53`): a
  `Context.Reference` over an `LRUCache`, a hit kept, a miss retried, no
  serialization (`:112-121`).
- `createCachedBinaryResolver` (`tools/agentCli/vendorPackages.ts:250-273`):
  a `SynchronizedRef.makeUnsafe` per resolver, created when
  `claudeAgentImport.ts:90` and `codexImport.ts:136` are imported, so it is
  module state no test or process can reset; a hit kept, a miss retried,
  every probe serialized behind the ref (`:257`).
- `CodexRouteEfforts` (`tools/agentCli/codexConfig.ts:129-135`): a
  `Context.Reference` over a `Map` plus a module lane map, a success kept,
  a timeout or spawn failure retried (`:189-228`), serialized per key with
  `withPerKeyLane` (`:248`).

The first and third follow G11h's rule (a process fact behind a
reference); the second is the shape G11h removed.

**The design decision behind it.** Where a process-lifetime probe result
lives and how concurrent misses meet. Each site decided it for itself.

**The better design.** The agent-CLI resolver keeps its found path in a
`Context.Reference` keyed by the resolver's `pathCommand`, as `FoundTools`
does, with the miss-sharing it has today done by `withPerKeyLane` on the
same key, as `codexRouteEfforts` does. `createCachedBinaryResolver`
becomes a plain function over that reference (its one `SynchronizedRef`
deleted), so its callers stay `findClaudeBinaryPath()` /
`findCodexBinaryPath()`. If the owner wants one helper, the three call
the same "get, else probe under the key's lane, keep if `keep(result)`"
over their own reference (three callers, so not a single-caller
extraction).

**What we give up, and risk.** Nothing visible; a test that relied on the
module ref surviving between cases (none found) would now get a fresh
reference per runtime.

**How I tried to refute it.** Looked for a reason the resolver must be
module state: its comment wants probes "one at a time, so callers racing
on a miss share the first probe's answer" (`vendorPackages.ts:238-249`),
which the per-key lane gives. Checked the refused lane record: it keeps
module lane maps because they hold no state at rest; a found path is
state at rest.

---

## TT-10: Each agent CLI's install advice is written five times and the copies disagree; on Windows two of them prescribe an install the resolver cannot use

- flags: repetition, information leakage, non-obvious code
- package: texra (`tools/agentCli/claudeAgentPlugin.ts`, `codexPlugin.ts`,
  `claudeAgent.ts`, `codex.ts`, `codexImport.ts`)
- kind: bug (wrong advice on Windows and for a missing bundled SDK) with
  the refactor that removes it
- size: S
- earlier: I10 (round 2, landed in #14790) fixed install advice written as
  prose and parsed back, for the LaTeX toolchain catalog; U7(e) is a
  missing system tool's advice per host. Neither read the plugin cards.
- open PR: none

**Evidence.** For Claude Code the install command appears in the card's
`installGuide` prose (`claudeAgentPlugin.ts:115-126`), the platform-picked
`installCommand` (`:128-134`), the availability check's
`binaryNotFoundMessage` (`:48-50`), the tool description
(`claudeAgent.ts:423`) and the auth list again in `configNotes`
(`claudeAgentPlugin.ts:136-137`). For Codex: `installGuide`
(`codexPlugin.ts:66-75`), `installCommand` (`:77-82`),
`binaryNotFoundMessage` (`:40-41`), the tool description (`codex.ts:442`)
and the SDK importer's `notFoundMessage` (`codexImport.ts:51-52`).

They disagree:

- On Windows, a global npm install leaves only shims TeXRA cannot spawn:
  the resolver rejects them on purpose (`vendorPackages.ts:218-233`) and
  `preferredInstallCommand` explains why it prefers `winget` there
  (`availabilityProbes.ts:98-101`). Claude's `installCommand` follows that
  (`winget`, `claudeAgentPlugin.ts:131`), but its `binaryNotFoundMessage`
  and the tool description still say `npm install -g @anthropic-ai/claude-code`,
  which, followed on Windows, ends in the same "binary not found": the
  global-prefix stage looks under `@anthropic-ai/claude-agent-sdk`, not
  `claude-code` (`claudeAgentImport.ts:103-112`), and PATH only accepts
  `.EXE`.
- Codex's guide says "On Windows, use WSL or the Codex app"
  (`codexPlugin.ts:70`), but `installCommand` has no `win32` entry, so the
  dashboard's install button runs `npm install -g @openai/codex` there.
- The Codex SDK is bundled into TeXRA by esbuild
  (`codexImport.ts:39-46`); a missing `@openai/codex-sdk` means a broken
  TeXRA, as Claude's importer says ("Reinstall TeXRA",
  `claudeAgentImport.ts:45-46`), yet Codex's says "Install with: npm
  install -g @openai/codex" (`codexImport.ts:52`), which installs the CLI
  and cannot supply the SDK. `probeSdkBinaryStatus` shows that message as
  the plugin's status (`availabilityProbes.ts:55-63`).

**The design decision behind it.** What a person runs to get a CLI on
this machine. `preferredInstallCommand` answers it once, but only the
card's button asks it; the guide, the status line and the tool
description each answer it in prose.

**The better design.** Each plugin declares one install record: the
per-platform command map it already passes to `preferredInstallCommand`,
the auth command, and the docs URL. The card's `installCommand` reads it
as today; the status line says "not found; install with
`${preferredInstallCommand(map)}`"; the guide's command lines are
rendered from the map (the prose keeps only what no command says, such as
WSL); the tool description names the CLI and leaves installation to the
dashboard (the model cannot install it anyway). A missing bundled SDK
reads "Reinstall TeXRA" for both. Codex's map gets a `win32` entry or the
guide stops recommending WSL; the owner picks which. Deleted: the four
hand-written command copies per plugin and the duplicate auth list in
`configNotes`.

**What we give up, and risk.** The guide's free-form layout becomes
partly generated. `preferredInstallCommand` probes package managers
(lazily, `availabilityProbes.ts:106-107`); calling it from the status line
runs that probe during the availability check, which already spawns.

**How I tried to refute it.** Checked whether the Claude SDK's bundled
platform package makes the npm advice moot: it does when present, and the
"not found" message is shown exactly when it is not. Checked the global
prefix roots for `claude-code` (absent, `claudeAgentImport.ts:103-112`).
Checked whether a Windows Codex npm install would be found: its binary
lives in a platform package under the global prefix, so it may be; the
disagreement with the guide stands either way.

---

## TT-11 (batched): Smaller instances of one fact with two spellings or two owners

- flags: repetition, vague name, shallow module
- package: texra; item 2 touches harness (`tools/core/definition.ts`,
  `shared/schemas/toolDefinition.ts`)
- kind: refactor
- size: S
- earlier: none for these items
- open PR: none

Each item is one sentence of evidence and one fix; together under 100
changed lines.

1. **GitHub annotation levels are spelled three ways.** The type union
   (`github/checkAnnotationLevels.ts:3`), the rank table's keys (`:8-14`)
   and the tool's `Schema.Literals(['failure', 'warning', 'notice'])`
   (`github/githubSubscriptionTool.ts:100`), plus a hand-written membership
   test in `normalizeCheckAnnotationLevel` (`checkAnnotationLevels.ts:23-30`).
   Fix: one `Schema.Literals` in `checkAnnotationLevels.ts`, its `Type` the
   level type, the rank table typed over it, the tool and the normalizer
   reading it (`Schema.is`).
2. **A tool call's card is handed raw input, so each tool with one
   decodes it again.** `ToolDefinition.card` is `(input: unknown) => ToolCard`
   (`harness/src/shared/schemas/toolDefinition.ts:47-51`), called with the
   raw input (`harness/src/agent/runtime/loop/toolUseDispatch.ts:427`); both
   tools that declare one repeat `Schema.decodeUnknownResult(schema)(raw)`
   and a `Result.isSuccess` branch (`AcceptRunFilesTool.ts:509-514`,
   `agentCli/codex.ts:450-453`), while `guard` gets the decoded input
   (`ToolGuard<T>`, `harness/src/tools/core/definition.ts:57`). Fix:
   `defineTool`'s `card?: (input: T) => ToolCard` wrapped once over its own
   `schema` into the definition's raw-input form.
3. **`card` names three things.** `TexraPlugin.card` is the dashboard's
   `PluginCard` (`registry.ts:151`), a tool's `card` is its transcript
   `ToolCard` (item 2), and `launch.card` is the id of the call row a
   child was launched from (`harness/src/agent/runtime/historyQuery/views.ts:281-283`).
   The plugin's is read in one place, through a cast
   (`controllers/settingsView/ToolDashboardData.ts:48-50`,
   `(plugin as TexraPlugin | undefined)?.card`). Fix: rename the plugin's
   to `dashboard` (or `listing`); the reader and every plugin literal that
   sets one change.
4. **Two setup helpers live away from their one reader.**
   `getChatGptSubscriptionStatus` and `SubscriptionProbeFailed` sit in the
   host-capability port file whose header says to keep it narrow
   (`setup/platform.ts:8`, `:115-169`), and `locateTool` is the only
   export of `setup/toolProbing.ts` (`:27`); each has one consumer,
   `ProbeEnvironmentTool.ts` (`:37-38`). Fix: move both into
   `ProbeEnvironmentTool.ts` and delete `toolProbing.ts`.
5. **`apply_team` lists every team twice in one request**: in the tool
   description and in the `teamId` annotation, both `describeTeams()`
   (`setup/ApplyTeamTool.ts:44`, `:114`). With TT-4's `Schema.Literals`,
   the annotation keeps the list and the description drops it.

**How I tried to refute them.** Grepped each symbol's consumers
(`getChatGptSubscriptionStatus`, `locateTool`: one file each; `card: (raw`:
two tools). Checked whether a card is ever called on input that failed
to decode and must still render: `toolUseDispatch.ts:423-428` builds it
for any call, and both tools return `undefined` for undecodable input,
which the wrapped form keeps.

---

## Good modules in this area

- `tools/agentCli/agentCliSessionStores.ts`: a thread claim is a `Scope`
  whose finalizer frees the id, held by the plugin's session services
  (`PluginHold`), so claims die with their session; 61 lines, no
  singleton.
- `shared/plugins/externalInquiry.ts` `acceptsThreadRow` /
  `supersedesThreadRow`: the thread's legal transitions as two total
  functions over the row, so a delayed or replayed update is refused by
  the store, not by each writer.
- `tools/inquiry/inquiryActions.ts` `recordInquiryDecision`: the
  re-delivery case for an attempt whose decision never committed is
  answered from the record, keyed on the turn, with the reason in place.
- `tools/setup/ConfigTools.ts` `update_config`: the key is a
  `Schema.Literals` over the allowlist and the value is decoded with the
  catalog row's own schema, so the tool validates exactly what the
  workspace reads (the shape TT-4 asks the other setup tools to copy).
- `tools/editorHost.ts` `makeEditorHost`: an attachment is an
  `acquireRelease` that only removes itself, so a newer window's
  attachment survives an older one's close.
- `tools/AcceptRunFilesTool.ts` `summarizeRejections`: one rank table
  decides which decline a whole-run rejection reports.
- `tools/agentCli/vendorPackages.ts` `importForeignSdk`: the bundler's
  three interop shapes resolved once at the one foreign edge, a missing
  package classified off the cause chain, not the message.
- `tools/agentCli/codexConfig.ts` `catalogEfforts`: decodes only the
  catalog entry it needs, so one malformed entry elsewhere cannot fail
  the lookup.
- `shared/constants/latexToolchain.ts` (read for TT-8): every consumer's
  list is derived from the one catalog, with the reason for each column.

## Already settled, left alone

- H9 (round 2): a plugin reaches its host six ways and `inquiryPanel?: true`
  is a bare flag (`registry.ts:357,427-436`); held by the owner with
  #14773 and, per `78e9abf`, not superseded by #14940. TT-2 is one defect
  inside it that stands alone.
- The module lane maps (`codexConfig.ts:135`, `lean/direct/lakeCommands.ts:30`):
  `M7-file-lanes-as-references` (refused).
- `documentState.ts`'s `taskFileSnapshots` `WeakMap` and the per-call
  `prepareRunWorkspace`: `DOCS-task-file-snapshots-weakmap-stays`,
  `DOCS-prepare-run-workspace-per-call-stays` (refused).
- The arXiv download's retry and cause pair: `ARXIV-download-retry-cause-pair`
  (I8, refused).
- `new AbortController()` in `claudeAgent.ts:162`: the SDK takes a
  controller, not a signal; the file is the lint rule's one named
  exemption (`oxlint.config.mts:370-375`).
- The four LaTeX dependency probes (doctor, setup, settings view, banner)
  over one catalog: recorded in the note
  `2026-11-04-core-dependency-check-overlap.md`, deleted once it was done
  (git history keeps it).
- The replacement presets and the regex/non-regex key pairs
  (`2026-11-03-fewer-processing-options.md` §6, kept by the owner); I12's
  `replacement/` items landed (#14807) and no regression was found in
  `engine.ts`. PR #14954 is rewriting `replacement/constants.ts`,
  `advanced.ts` and `rules.ts`; nothing proposed there.
- The latexdiff file-name grammar (L2-7.1, landed): every `_diff` /
  `-diff` spelling under `latex/` and `tools/` now reads
  `latexdiff/diffFileNameManager.ts`; no regression.
- The round-2 GitHub, Lean and Zotero findings (H1 to H8, H10, H11):
  landed; the files read as the PRs left them. The Zotero
  snapshot-or-metadata union was kept with reasons in #14807.

Dropped on verification (not reported): the setup tools' in-body
capability checks (live per step, a window can detach mid-call); the
`probe_environment` description's tool list (it matches the derived
list); the settings view's install-command allowlist (a separate path
from the plugin cards); `DiagnosticsPorts` as a pass-through bundle (too
small to matter); a suspected repetition between the PR and repo pollers
(the shared parts are already in `poller.ts`); the background-launch
receipt written in four places (three are the harness's, LI's lens);
`documentTools.ts` `located`'s derived `ok` field (one line); the
`ConfigTools` catalog lookup that throws (a startup bug by design);
the codex `CODEX_ITEM_TYPES` table (total over the SDK union, correct);
the `card` decode as a harness-only issue (kept as TT-11 item 2 with its
two app callers); and the two plugin ids kept "for back-compat with persisted" preferences (`github/plugin.ts:22-25`, which H9 names, and `agentCli/claudeAgentPlugin.ts:34-38`, the same case H9 did not list; both ride H9).
