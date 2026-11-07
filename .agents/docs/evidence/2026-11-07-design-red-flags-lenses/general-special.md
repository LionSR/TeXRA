# General and special purpose (ch. 6): interfaces shaped around one caller

Read at main `03c2f51d5d480ca199b7192c687595d20aced5d7`. Read-only lens audit
of `packages/*/src` (tests only where an interface exists for them). Rules and
format: `../2026-11-06-design-red-flags-round-2/BRIEF.md`, with this folder's
`BRIEF.md` changes.

**Summary.** The harness's general core mostly does what the rule asks: it
takes the app's vocabulary as data. The request model's `plugin` case, the
plugin list, `HostSkillOptions.projectFolder` and the settings rows'
`surfaces` all do this. A grep of the harness for app words (LaTeX, paper,
Zotero, Lean, Codex, document task) finds one hit in code: the tool-row
fold's `accept_run_files` matcher. The lens's strong instances sit one layer
out, where a "general" surface is shaped like its first host or caller:

- tool cards are chosen by tool name;
- the dialog ports restate VS Code's `window` API;
- the settings view asks which host it is in, not what the host can do;
- the tool contract keeps a case only a test layer builds;
- a controller has one setter per selection kind;
- the desktop workbench switches on pane kind in six places.

"The opposite" (a general layer with one user that adds only a name) has few
instances not already found. Each of the ones I found is cited under "Already
settled".

## Numbers

| Count                                                                                                                                                                                     | Value                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Package source lines (files): `texra` 82,852 (470), `harness` 80,391 (396), `cli` 45,328 (236), `extension` 16,748 (94), `desktop` 14,661 (91), `llm` 12,029 (54), `trace-viewer` 418 (4) |                                                                           |
| App-vocabulary words in harness code lines (not comments, descriptions or prompts)                                                                                                        | 1 (`toolRowSections.ts:558`, `'accept_run_files'`)                        |
| Tool-name tests in display code (`toolDisplayKind(..) ===`, `normalizeToolName(..) ===`, `isMcpToolName(`, `=== AGENT_TOOL_NAME`, name-keyed tables), 4 packages                          | 30 sites                                                                  |
| Host-identity tests in the shared settings view and its bindings (`desktopHost`, `isDesktopHost`, `installsExtensions`)                                                                   | 24 sites                                                                  |
| Partial implementations of, or member renames from, the dialog ports (`Pick<PromptHost/MessageHost,…>`, `MessageHost['…']`)                                                               | 4 + 6                                                                     |
| `ToolContext` providers in production / test layers that build one without a run                                                                                                          | 1 (`toolUseDispatch.ts:542`) / 1 (`nativeToolTestLayer`), 16 no-arg calls |
| Per-kind branches in `desktop/src/renderer/workbenchController.ts`                                                                                                                        | about 28 `kind ===` tests in 6 functions                                  |

Comment share of the files the findings centre on: `ToolTypes.ts` 63% (226
lines), `uiHosts.ts` 52% (266), `RunCall.ts` 37% (343), `setup/platform.ts`
36% (193), `toolRowModel.ts` 28% (368), `settingsHostBindings.ts` 25% (166),
`VscodeUiHost.ts` 22% (202), `toolRowSections.ts` 11% (600),
`WorkspaceAgentsController.ts` 11% (393), `workbenchController.ts` 2% (612).
The comments in `uiHosts.ts` and `ToolTypes.ts` explain which host fills
which member, and which caller has no run. That is ch. 13's "hard to
describe" signal.

---

## Finding 1. How a tool call is painted is decided by tool name, in the harness's general fold and in each host, while the general mechanism (a card the tool states) has one tool user

**Red flags:** special and general code mixed (a general fold with a branch
per tool, including an app tool and an external agent's tool names);
information leakage (each tool's input shape known by the renderer); two
representations (a stated `card` beside the name tables; icons on the app
plugin beside kinds in the harness); change amplification.

**Evidence.**

- **The harness's own name tables.**
  - `shared/tools/toolKind.ts:24` `TOOL_DISPLAY_KIND`: five names to five
    kinds. `isEditLikeToolName` (`:58-66`) adds Claude Code's built-in names
    and two substrings: `name === 'edit' || name === 'multiedit' ||
    name.includes('str_replace') || name.includes('text_editor')`.
  - `toolDisplayName.ts:16` `TOOL_LABEL` (`agent` → `Agent`).
  - `toolInputPreview.ts:25` `TOOL_PREVIEW_INPUT_KEY` (`bash: 'command'`,
    `agent: 'agentName'`), plus `if (name === 'executions')` (`:55`) and the
    script branch (`:57`).
- **The general fold** (`shared/transcript/toolRowSections.ts:517-567`,
  `SECTION_BUILDERS`) is nine matchers keyed by name: edit-like, read,
  write, script, `memory`, `executions`, `accept_run_files` (an app tool,
  `packages/texra/src/tools/AcceptRunFilesTool.ts:460`), `agent` and MCP.
  - `dispatchSections` decides `carriesOutput` with two more name tests
    (`:588-595`).
  - `inputFilePath` (`:512`) reads `file_path` because "a delegated
    sub-agent's built-in Read/Write/Edit tools use Anthropic's own
    `file_path`".
  - `toolRowModel.ts` repeats the tests: `executions` at `:216`, the `script`
    and `bash` kinds at `:225-226`, `bash` at `:321`, `bash || mcp` at
    `:358-359`.
- **The hosts test names again.**
  - CLI: `isBashKind` (`packages/cli/src/chat/tui/panes/toolRenderers.tsx:333`)
    and `isMcpToolName || toolName === AGENT_TOOL_NAME` (`:374-378`).
  - GUI: `displayKind === 'bash' || tools.terminalOutput.includes(name)`
    (`packages/texra/src/ui/progress/formatters/logFormatters/toolFormatters.ts:106-108`).
  - GUI: `TOOL_OUTPUT_LANGUAGES` (`ui/progress/formatters/constants.ts:38-42`),
    whose `execute` and `run` rows name no tool in the tree.
  - GUI: `TOOL_DEFAULT_TIMEOUTS` with its own `executions` branch
    (`toolFormatters/helpers.ts:43-72`), which decodes `run_in_background`,
    `action` and `timeout` from the tool's input a second time.
- **The app's half rides another channel.** `TexraPlugin.icons` (14
  declarations) and `terminalOutput` (1, Codex) (`packages/texra/src/tools/registry.ts:145-151`)
  are flattened into `HostSnapshot.tools` (`openGuiWindow.ts:337-343`,
  `shared/session/hostSnapshot.ts:96-101`). The GUI alone reads them, so the
  CLI and the trace viewer never see a plugin's display facts. The Claude
  plugin's display knowledge is split three ways:
  - its icon, `str_replace_editor: 'pencil'` (`claudeAgentPlugin.ts:105`);
  - its edit classification, the `str_replace` substring in the harness;
  - its input shape, `file_path` in the harness. The plugin already
    switches on each of its tools (`describeToolInput`,
    `claudeAgentShared.ts:235-255`).
- **The general mechanism exists.** `ToolDefinition.card`
  (`shared/schemas/toolDefinition.ts:41-51`) is "what a plugin's tool shows
  that the harness knows nothing of". It is recorded on `tool.start`
  (`agent/runtime/loop/toolUseDispatch.ts:347-349`;
  `shared/schemas/traceEvent.ts:62`), and `toolRowModel` paints it in place
  of the name dispatch (`:297-317`). One tool states one (`codex.ts:430`);
  the Codex event logs state three more (`codexShared.ts:122,166,205`).
- **The compile check guards the copy, not the fact.**
  `_CanonicalDisplayNamesAreBuiltIns` (`packages/harness/src/tools/builtinPlugins.ts:47-54`)
  checks the five `TOOL_DISPLAY_KIND` names against the built-ins. The four
  other names in `SECTION_BUILDERS` (`memory`, `executions`,
  `accept_run_files`, `agent`) are unchecked: renaming `accept_run_files`
  silently drops its file-group card.

**The design decision behind it.** "How is this call shown" is answered by
the reader, from a name, instead of by the tool that knows its own input. The
general answer (`card`) was added later for plugins and left the built-ins on
the name path.

**The better design.** The tool declares how its calls are shown, and the
row records it, as `card` is recorded today:

```ts
// ITool, beside `slow` and `scriptGlobal`
readonly display?: {
  /** The section shape; absent: the generic labelled input/output. */
  readonly kind?: 'edit' | 'read' | 'write' | 'shell' | 'script'
    | 'fileGroups' | 'delegation' | 'mcp' | 'memory' | 'executions';
  /** The input field that names what a call acts on (the header preview). */
  readonly preview?: string;
  /** The UI kit's icon name. */
  readonly icon?: string;
};
```

`tool.start` gains `display: { kind, preview, icon }` (an `optionalKey` field
of `Schema.Literals`). A plugin reporting an external agent's call states the
same in its `ToolUseLog`, so Claude's `Edit` says `kind: 'edit'` once, in
the plugin. The fold dispatches
`SECTION_BUILDERS: { [K in ToolDisplayKind]: Builder } satisfies Record<…>`
on the recorded kind, so a missing kind fails to compile. Each builder reads
the path field the declaration names, not a list of spellings. The trace
viewer and the CLI read the same row, with no plugin list.

What is deleted:

- harness: `TOOL_DISPLAY_KIND`, `TOOL_LABEL`, `TOOL_PREVIEW_INPUT_KEY`,
  `isEditLikeToolName` (2 consumers), the `normalizeToolName` keying of
  display rules (13 references in 7 files; it stays only for the MCP label),
  the nine name matchers, the `carriesOutput` and `showsNoOutputMarker` name
  tests, the `file_path` fallback, and the compile guard;
- app: `TexraPlugin.icons` (14) and `terminalOutput` (1), and
  `HostSnapshot.tools`;
- GUI: `TOOL_OUTPUT_LANGUAGES` (dead rows) and the name-keyed timeout table.
  The GUI timer reads the tool's declared default.

In all, the 30 name-test sites become 0. Callers write `display` on the
tool, and renderers switch on `row.display.kind`.

**Design it twice.** (A) Carry kinds by name in `HostSnapshot.tools`, beside
the icons. That keeps one owner per tool, but it is GUI-only (the CLI and
the trace viewer have no snapshot) and still keyed by a string. (B, chosen)
Record the declaration on the row: every reader, including a stored run
whose plugin is gone, paints it the same.

**What we give up.** `tool.start` changes (row version 2 → 3, no upcaster,
`rowVersions.ts:227`). Rows written by an earlier 1.0 build read as
`DatabaseRowEarlier`, per the storage-format rule. Agent CLIs' tool names no
longer get a diff by accident; the plugin must say `kind: 'edit'`.

**Change amplification.** "A plugin tool that edits files gets the diff
card." Today: the harness's `toolKind.ts` (the substring hack, since the
guard forbids a non-built-in name), plus `toolRowSections.ts` if it needs
sections, plus the app plugin's `icons` entry. That is 3 files in 2 packages,
one of them the harness. After: one `display` field on the tool.

**Depends on:** none. Land it in E's storage-format PR (round-3 plan,
"R2: one storage-format PR") to share the golden-store regeneration. PR
#14796 (open) touches `openGuiWindow.ts`, where the icon flattening goes.
`src/test-kernel/cli/ToolRenderers.vitest.ts` is pinned to names.

---

## Finding 2. The host dialog ports are VS Code's `window.show*Message` and `showInputBox`, member for member; every implementation reduces them to two primitives, and the app uses three of the seven

**Red flags:** an interface shaped around one host; information leakage (VS
Code's method names in an error literal; VS Code's option spelling);
overexposure (members and options no app caller uses); repetition (bespoke
message boxes beside the port).

**Evidence.**

- **The ports** (`packages/texra/src/hosts/uiHosts.ts`):
  - `MessageHost` (`:143-147`): `showInfoMessage`, `showWarningMessage`,
    `showErrorMessage`.
  - `PromptHost` (`:198-214`): `info`, `warning` (with `items` and an
    answer), `confirm`, `input`.
  - The option types are VS Code's: `PromptMessageItem.isCloseAffordance`
    (`:153`, `vscode.MessageItem`'s field), `modal` and `detail` (`:158-161`,
    `vscode.MessageOptions`), `placeHolder` (`:178`, `InputBoxOptions`'s
    capital H).
  - `NotificationFailed.member` is
    `Literals(['showInfoMessage','showWarningMessage','showErrorMessage'])`
    (`:117-128`). The desktop stamps VS Code's method names onto Electron
    failures (`desktopDialogs.ts:47,127,166`; `desktop/src/main/index.ts:271`),
    and nothing reads `member`.
- **Each implementation collapses to "notify" and "choose among labels".**
  - VS Code: one `showMessage(member, …)` behind all five message members
    (`packages/extension/src/frontend/hosts/VscodeUiHost.ts:153-180`), plus
    a private `error`.
  - Desktop: one `showMessageBoxOfType` (`desktopDialogs.ts:45-71`), plus
    `confirmDialog` (`:80-101`).
  - CLI: `appendLocalNotice` or `chooseItem`, and only
    `Pick<PromptHost, 'info'|'confirm'|'input'>` (`tuiUiHost.tsx:115`). It
    has no `warning`, so the settings body's `prompt.warning`
    (`settingsMemoryCommands.ts:44`) has no terminal implementation.
- **What the app actually calls.**
  - `confirm`: 6 sites (`settingsPluginCommands.ts:43`,
    `settingsMemoryCommands.ts:108`, `settingsAgentCommands.ts:276,320,501`,
    `SettingsProfileKeyController.ts:75`).
  - `input`: 5 sites.
  - `prompt.info` and `prompt.warning`: 2 sites, both a bare message, which
    is `MessageHost`'s toast under a second name.
  - No app caller passes `items` or `isCloseAffordance`. The only callers of
    the answerable form are VS Code's own modules (`vscodeUi.info(…, { items })`,
    `subscriptionSignIn.ts:79,106`, `extension.ts:267`,
    `agentEventListeners.ts:201`, `arXivCommands.ts:124`).
- **The app renames the members.** `showInfo: MessageHost['showInfoMessage']`
  and `showWarning` appear in four dependency bags:
  `controllers/progressView/exportTranscript.ts:57-58`,
  `controllers/session/hostRunActions.ts:114-115`, `openGuiWindow.ts:415-416,421,462,468-469,520`
  and `latex/acceptedFileTarget.ts:111`, plus the adapters at
  `desktopHostRequests.ts:255` and `commands/latex/compareCommands.ts:53`.
  `settingsPresentation` re-derives `notice` and `alert` from the port
  (`settingsHostBindings.ts:128-160`). Those are the app's own words.
- **Hosts write the general form by hand.** The desktop builds five
  bespoke "choose among labels" boxes beside its port: `confirmDialog`,
  `showErrorDialog` with a guide button (`desktopDialogs.ts:109-130`),
  `showInstructionDialog` (`:144`), `showDiscardDialog` and
  `announceRelease` (`desktopWindowHost.ts:178-210`).

**The design decision behind it.** The port was extracted from the first
host's API, so its shape is VS Code's, and every other host emulates it.

**The better design.** One port, three members, in the app's words:

```ts
class Dialogs extends Context.Service<
  Dialogs,
  {
    /** A notice nobody answers. Never fails: a host that cannot show it logs
     *  the cause at warn. */
    notify(
      level: 'info' | 'warning' | 'error',
      message: string,
    ): Effect.Effect<void>;
    /** A modal question naming its action; false on cancel. */
    confirm(q: {
      message: string;
      action: string;
      detail?: string;
    }): Effect.Effect<boolean, DialogFailed>;
    input(f: {
      prompt: string;
      placeholder?: string;
      secret?: boolean;
    }): Effect.Effect<string | undefined, DialogFailed>;
  }
>()('@texra/hosts/Dialogs') {}
```

`choose`, `items` and `isCloseAffordance` stay inside the VS Code module,
where their only callers are. The answerable `info` becomes that module's
private wrap.

What is deleted:

- `MessageHost` and `PromptHost` (7 members → 3), with `PromptMessageItem`,
  `PromptMessageOptions`, `BaseDialogOptions` and `NotificationFailed`
  (with `member`). `PromptFailed` becomes the one `DialogFailed`.
- The four `showInfo`/`showWarning` renames, and the `Pick<>`s
  (`settingsHostBindings.ts:38-39`, `SettingsProfileKeyController.ts:14`,
  `tuiUiHost.tsx:115`).
- The five `catchTag('NotificationFailed', …log)` sites
  (`desktopWindowHost.ts:160`, `desktopSettingsIpc.ts:110,205`,
  `desktopPreviewHost.ts:108`, `settingsHostBindings.ts:135`): `notify`
  logs its own failure.

Callers write `dialogs.notify('info', m)`, `dialogs.confirm({ message,
action: 'Delete' })` and `dialogs.input({ prompt, secret: true })`.

**What we give up.** VS Code's non-modal confirmation for one call
(`SettingsProfileKeyController.ts:77`, `modal: false`); every confirm is
modal, as the desktop's and the CLI's already are. A caller cannot learn that
a toast failed to show. Every caller today logs and drops that failure.

**Change amplification.** "A fourth host (a web client)." Today it
implements 7 members, five option fields and the error's member literals.
After, 3 members.

**Depends on:** none. The bags it shrinks overlap G4 and G5
(`openGuiWindow`'s bag, `hostRunActions`; round-2 order "2.2") and B's 3.3
files. Land it after those, or in them.

---

## Finding 3. The shared settings view asks "which host am I" instead of "what can this host's editor do"; installing a VS Code extension is three entries and three implementations

**Red flags:** a general module with branches for one host (host identity in
shared frontend and body); one method per caller's case
(`installLatexWorkshop` beside `installToolExtension`); sentinel values (the
desktop reports "applied" for settings it has none of); repetition.

**Evidence.**

- **The frontend branches on host identity.** `SettingsApp.ts:88-89` reads
  `data-desktop-view`. That identity decides:
  - the sections (`:147-151`, "`vscode` exists only in VS Code, Appearance
    only on the desktop");
  - the appearance slot (`:300`);
  - in `LaTeXTab.ts`: the LaTeX Workshop card (`:331-333`), the
    inline-criticism row (`:479`; the row's own comment says "the desktop
    LaTeX page hides it", `texraSettings.ts:249-251`) and the installer
    button's copy (`:321`).

  14 references in two files. The row already says where it shows
  (`surfaces: { settingsView: 'latex' }`, `:262`), but not which host can
  serve it.

- **The backend states the same facts again as flags, sentinels and
  refusals.**
  - `installsExtensions: boolean` is passed through three layers:
    `SettingsViewMessageHandler.ts:102`, `desktopSettingsIpc.ts:170` →
    `sharedSettingsCommands.ts:87,126` → `settingsToolCommands.ts:40-60` →
    `ToolDashboardData.ts:106,189`.
  - `latexEditorStatus()` is a binding (`settingsHostBindings.ts:61-63`)
    that the desktop answers with sentinels:
    `{ outDir: true, autoRevealExclude: true, latexWorkshopInstalled: false }`
    (`desktopProjectSurface.ts:198-204`).
  - The desktop registers three `unsupported` handlers
    (`desktopSettingsIpc.ts:187-191`).
- **Installing an extension is two messages for one action.**
  - `INSTALL_LATEX_WORKSHOP` (no payload; `LaTeXTab.ts:198`) and
    `INSTALL_TOOL_EXTENSION { extensionId }` (`PluginCard.ts:232`)
    (`shared/ipc.ts:68,88`, `settingsViewMessages.ts:597-600,660`).
  - Both reach one closure; the only difference is which page refreshes
    (`latexSettingsHandlers.ts:105-121,165-168`).
- **Three VS Code installs, three "is it installed" reads.**
  - Installs: `latexSettingsHandlers.ts:113`, `frontend/vscodeSetupPlatform.ts:31`
    (`SetupPlatform.extensions.install`) and `frontend/ui/instruction.ts:109`.
  - Reads: `latexSettingsHandlers.ts:88`, `vscodeSetupPlatform.ts:51` and
    `frontend/setup.ts:48`.
  - The setup agent's `install_vscode_extension` gates on
    `hostCapability: 'extensions'` (`InstallVscodeExtensionTool.ts:92`) and
    reads `platform.extensions?.isInstalled(LATEX_WORKSHOP_EXT_ID)`
    (`ProbeEnvironmentTool.ts:207`).
  - "Can this host install extensions" is therefore a boolean, a port
    member's presence and two refusals.

Found: G8 names `installsExtensions` as one of "two booleans on
`SettingsHostBindings`" and keeps it (`../2026-11-06-design-red-flags-round-2/G-app-controllers.md:582,600`).
H9 names the setup port's hand-off shapes. The new angle is that the boolean,
the port member, the second message and the frontend's host test are one
missing service.

**The design decision behind it.** "This host has an editor with
extensions and settings" is a capability. Each surface spelled it as the
host's name, or as a flag beside a host-only handler.

**The better design.** One app service that only VS Code serves:

```ts
class EditorIntegration extends Context.Service<
  EditorIntegration,
  {
    readonly installed: (extensionId: string) => boolean;
    readonly install: (extensionId: string) => Effect.Effect<void, Error>;
    readonly recommendedSettings: () => {
      outDir: boolean;
      autoRevealExclude: boolean;
    };
    readonly applyRecommended: (
      field?: LatexRecommendedSettingField,
      reset?: boolean,
    ) => Effect.Effect<void, Error>;
  }
>()('@texra/hosts/EditorIntegration') {}
```

The VS Code root provides it with `Layer.succeed`. The settings body, the
setup plugin and the startup recommendation read
`Effect.serviceOption(EditorIntegration)`. Presence is the capability; there
is no flag. The settings host state carries
`editor: { latexWorkshop: 'installed' | 'missing'; recommended: {…} } | null`,
and the frontend renders the editor sections and rows when `editor` is
non-null. One `INSTALL_EXTENSION { extensionId }` message is handled in the
shared body, which repaints every input that names the extension.

What is deleted:

- `installsExtensions` (7 references in 5 files);
- `latexEditorStatus` (binding, 2 implementations, the sentinels);
- `INSTALL_LATEX_WORKSHOP` (constant, schema, handler, sender);
- the desktop's three `unsupported` rows;
- `SetupPlatformShape.extensions` (the setup tools read the service);
- two of the three install and is-installed copies;
- the `desktopHost` branches that test editor facts (4 in `LaTeXTab.ts`, the
  `vscode`-section filter). The `appearance` slot and the navigation
  orientation stay: they are the desktop shell's own chrome.

**What we give up.** The desktop no longer gets the LaTeX tab's "Not found"
badge for LaTeX Workshop. It already hid that card.

**Change amplification.** "A second recommended extension (Lean 4) on the
LaTeX page." Today: a new or reused message, its refresh choice, a desktop
`unsupported` row, the frontend host test and an is-installed read. That is
5 files. After: one row naming the extension id. 1 file.

**Depends on:** G8 (the settings body's pages as streams) is the natural
host. The service can land alone. Owner: round-3's R3-B (settings and
commands).

---

## Finding 4. The tool-call contract carries an "outside any run" case that only a test layer builds; 30 production sites narrow or branch on it

**Red flags:** an interface shaped around one caller (the test fixture); a
general path with a special case (`run?`, `requests?`, `RunCall` null);
errors not defined out of existence (`requireRun`'s refusal is unreachable in
production).

**Evidence.**

- **The optional case.** `ToolEnv.run?` ("absent for a standalone host
  invocation", `agent/core/tools/ToolTypes.ts:196`) and
  `ToolContextShape.requests?` ("absent for a standalone host invocation
  outside an agent run", `:215-217`). `RunCall` is a `Context.Reference`
  whose default is `null`, "a standalone host invocation"
  (`agent/runtime/RunCall.ts:262-268`). `ChildRuns` defaults to
  `noRunChildRuns`, eight refusals (`agent/runtime/ToolServices.ts:122-135,165`).
- **Production never builds it.** The one production provider of
  `ToolContext` is the dispatch, which always passes `run` and `requests`
  (`agent/runtime/loop/toolUseDispatch.ts:542-551`). `grep` finds no other
  `provideService(ToolContext` in `packages/*/src`, and no SDK example calls
  a tool outside a run.
- **Only the test layer builds it.** `nativeToolTestLayer`
  (`src/test-kernel/support/nativeToolTestLayer.ts:91-200`) omits both when
  a suite passes no `run`: 16 no-argument calls.
- **Every reader pays for it.**
  - 25 `requireRun`/`requireToolRun` calls narrow the call and fail with
    "requires an active run context" (`RunCall.ts:282-299`).
  - 5 `callerRun` readers branch:
    - `MemoryTool.ts:88` stores `runId: caller?.runId` as an optional field;
    - `lean/LspTools.ts:469` opens a second scope path,
      `run ? Scope.provide(run.scope) : Effect.scoped(call)`;
    - `OpenPdfTool.ts:54`, `ExternalInquiryTool.ts:230` and
      `ScriptTool.ts:172` carry `run?.…` through their bodies.
  - Comments justify branches by this case
    (`texra/src/tools/agentCli/agentCliShared.ts:172-175`).

Found: E names `ToolEnv.run` and `RunCall.run` as one object under two tags
(`../2026-11-05-design-red-flags/E-loop-tools.md:446-467`; the 2026-11-01 note
keeps `RunCall` as the door). The new angle is that the optional case
behind both has no production caller.

**The design decision behind it.** The tool contract was written for a
caller that might invoke a tool directly. That caller became the test
fixture, and the case stayed in the interface.

**The better design.** A tool call is always a run's call. `ToolContextShape`
requires `env.run` and `requests`, and `RunCall` is a required
`Context.Service`, not a nullable `Context.Reference`. The test layer builds
a run, as it already does when a suite passes one (`testRunRegistry`, the
same file). With E's finding, `run` lives once, on `RunCall`.

What is deleted:

- `requireRun`, `requireToolRun` and `callerRun` (30 production sites
  become field reads), with the "requires an active run context" refusal;
- `noRunChildRuns` and the `ChildRuns` default;
- the `?` on `run` and `requests`;
- `LspTools`'s second scope path, and `MemoryInvocation.runId`'s
  optionality.

Callers write `const { run, requests } = yield* ToolContext`.

**What we give up.** An embedder cannot call a tool's `call` with a
hand-built `ToolContext` that has no run. None does. The SDK exports
`ToolContext` (`plugins.ts:82`), so this narrows a public type at 0.x. The
16 test calls gain a run fixture.

**Change amplification.** "A new tool that needs its run." Today: it imports
`requireRun`, names itself in the refusal, and the model can read a refusal
that never occurs. After: it reads the field.

**Depends on:** E's `ToolEnv.run` / `RunCall` finding. Land them together:
one door, required.

---

## Finding 5. `WorkspaceAgentsController` has one setter per selection kind and a set/clear pair for one optional; both callers parse a selection and then pick the method

**Red flags:** an interface shaped around one caller's cases (`setTeam`,
`setEnabledAgentKeys`, `setAll`, `setInherited` for the four members of one
union); conjoined methods (`setDefaultTeam` / `clearDefaultTeam`, called as
`value ? set(value) : clear()`).

**Evidence.**

- **One union, four setters.** `WorkspaceAgentsSelectionSchema` is
  `inherit | all | team | custom` (`shared/schemas/workspaceAgents.ts:12-23`).
  The harness's controller writes it through four public setters
  (`agent/workspaceAgents/WorkspaceAgentsController.ts:261,279,304,314`).
  Each wraps the private `setSelection`/`writeSelection` (`:237-252`) and
  adds its kind's one side effect:
  - a team must exist (`requireTeam`, `:263`);
  - a custom list records its choices (`:285`);
  - `all` clears the hidden custom agents (`:308`).
- **Callers.**
  - `setInherited`: 2, `setAll`: 2, `setTeam`: 3, `setEnabledAgentKeys`: 1
    (`packages/cli/src/commands/config.ts:126-137`,
    `packages/cli/src/chat/tui/forms/WorkspaceAgentsForm.tsx:229-252`,
    `packages/texra/src/shared/teamPlan.ts:153`).
  - Both CLI callers turn a string into the kind and then branch to the
    setter: `if (keyword(agents) === 'inherit') … else if ('all') … else if
    (startsWith('team:')) … else`.
  - `setDefaultTeam` and `clearDefaultTeam` (`:383,390`) are called as one
    choice by both CLI callers (`WorkspaceAgentsForm.tsx:278`;
    `config.ts:140-155`).

Not in rounds 1 to 3. P's finding gives this file's team key a `StateKey`
(`../2026-11-07-design-red-flags-round-3/P-settings-model.md:388,401`) and
does not touch the setters. M8 moves `teamMembers` out of the port.

**The design decision behind it.** The controller grew a method each time a
caller needed a new kind. The decision "write this selection" was never
named.

**The better design.** `select(selection: WorkspaceAgentsSelection)`, one
`Effect.fn` that switches on `selection.kind` for the side effect and writes
in the one lane. `setDefaultTeam(teamId: string | undefined)` takes
`undefined` for "none". Callers decode once and call once:
`yield* agents.select(selection)`. The CLI's two string grammars
(`--agents inherit|all|team:<t>|list` and the form's `team:<id>` values) can
share one decoder, but the controller change does not need it.

What is deleted: four setters → 1 (`setTeam`, `setEnabledAgentKeys`,
`setAll`, `setInherited`), `clearDefaultTeam`, the private `setSelection`,
and the seven-branch dispatch at the two CLI sites.
`src/test-kernel/controllers/WorkspaceAgentsController.vitest.ts` is renamed
to the new calls.

**What we give up.** The method names that read as sentences at the call
site.

**Change amplification.** "A fifth selection kind." Today: the schema,
`resolveSelection`, a new setter, and both CLI dispatchers: 4 files. After:
the schema, `select`'s case and the parsers: 2 or 3 files.

**Depends on:** none.

---

## Finding 6. The desktop workbench is a general dock that knows every pane kind in six functions; the kind table already exists, but the behaviour lives in switches

**Red flags:** a general module with a branch per case; change
amplification; the dependencies bag shaped one field per pane.

**Evidence.** `packages/desktop/src/renderer/workbenchController.ts` (612
lines, 2% comments) tests `kind` about 28 times:

- activation (`:177-193`: an editor relayouts, a terminal activates, a
  browser loads once, logs reattach);
- the active-panel handler (`:446-450`);
- `mount` (`:199-238`, eight branches);
- `release` (`:241-253`);
- `positionFor` (`:301-330`), where the "document" set
  `['editor', 'pdf', 'review', 'browser']` is spelled twice (`:310,324`);
- the first-add sizes (`:526-531`);
- the per-update PDF refresh (`:548`).

The dependencies are one field per pane (`conversationView`, `fileTree`,
`editorFor`, `closeEditor`, `terminalPane`, `reviewPane`, `pdfPane`,
`logsPane`; `:32-49`), wired one by one at `projectWorkbench.ts:192-211`.
`WORKBENCH_KIND_META` (`desktop/src/shared/desktopShellState.ts:8-24`) holds
each kind's icon, label and `singleton`. U lists it as a good table
(`../2026-11-07-design-red-flags-round-3/U-cross-package.md:543`).

**The design decision behind it.** The table covers what a kind _is_ and not
what it _does_, so the dock decides each pane's behaviour.

**The better design.** The workbench is general over a pane table. Each
pane module exports its entry, and
`panes: { [K in WorkbenchKind]: PaneKind } satisfies Record<…>` is the
controller's one dependency:

```ts
interface PaneKind {
  readonly zone: 'left' | 'document' | 'bottom'; // positionFor, the "document" set
  readonly size?: { width?: number; height?: number };
  mount(tab: WorkbenchTab, host: HTMLElement): void;
  activate?(tab: WorkbenchTab): void;
  release?(tab: WorkbenchTab): void;
}
```

What is deleted: the about 28 kind tests, the two copies of the document
set, and seven of the eight pane fields of `WorkbenchControllerDeps`.
`positionFor` reads `zone`. The editor's first-open resize of agent and
files (`:531-541`) stays a document-zone rule.

**What we give up.** Reading one pane's whole lifecycle in the controller.
It moves to that pane's module, which is the point.

**Change amplification.** "A ninth pane kind (a notebook)." Today:
`WORKBENCH_KIND_META`, four to six functions in the controller, a new
dependency field and its wiring: 3 files, about 6 sites. After: the pane's
entry and its META row: 2 files.

**Depends on:** none. N8 (the editor pane's generation counters) and N9 (the
window lifecycle) are other files.

---

## Finding 7. Smaller items, batched

- **The harness's stored follow-up names one app plugin.**
  `FollowUpSender`'s notice case is
  `{ kind: 'notification', source: Schema.Literal('github') }`
  (`packages/harness/src/shared/schemas/followUp.ts:43-46`, the case at `:44`). It has one
  producer (`packages/texra/src/tools/github/subscriptionsLayer.ts:144`) and
  no reader of `source`: the two readers test `kind` only
  (`followUpMessages.ts:86`, `RunInput.ts:66`). A second plugin that posts
  notices edits the harness's row schema. Make it `source: Schema.String` (a
  plugin id, as `PluginRequestSchema.plugin` is, `request.ts:122`), or drop
  the field. Decoding stays compatible either way, so there is no version
  bump.
- **A start option for one host's case.** `StartOptions.continues`
  (`shared/session/runtimeRequest.ts:349-351`) has one producer, the CLI chat
  when its previous root failed or there was none
  (`packages/cli/src/chat/chatSessionController.ts:486-492`). It copies
  that round's human grants (`agent/runtime/rootLaunch.ts:112-121`). The
  comment there ("each chat round mints a fresh root run id") no longer
  describes the routing at `:989-1000`, which follows up on a live or
  stopped root. Whether a failed root should be resumed instead is a product
  call. I report it without a design.
- **`PromptInputOptions.password`** is passed by both callers that ask for a
  secret (`settingsGitCommands.ts:62`, `SettingsProfileKeyController.ts:48`).
  It is not a special case. Finding 2 renames it `secret`.

## Good modules in this area

- **The request model's plugin case** (`packages/harness/src/shared/schemas/request.ts:112-130`):
  a plugin opens a request in its own vocabulary, declares its answers, and
  "the harness stores it and reads no more of it than the request and run it
  names". This is what finding 1 asks of tool display.
- **`ToolCardSchema`** (`shared/schemas/progressView/data.ts:50-93`): "plain
  data in the generic section kinds every renderer already paints, so the
  fold stays plugin-agnostic". It is the right shape with too few users.
- **`Plugin` and `TexraPlugin`** (`packages/harness/src/tools/plugins.ts:103-150`;
  `packages/texra/src/tools/registry.ts:145`): the harness's plugin carries
  what a run needs, and the app extends the type with how it shows a plugin,
  keyed by id.
- **`HostSkillOptions.projectFolder`** (`packages/harness/src/skills/skillSources.ts:25-35`):
  TeXRA's `.texra` reaches the harness as data.
- **`SettingSurfaces`** (`packages/texra/src/shared/settingsView/settingSurfaces.ts:42-54`):
  a row says which UI renders it. Finding 3 extends the same idea from "which
  UI" to "which capability".
- **`definedHandler` / `dispatchCommandFromRegistry`**
  (`packages/texra/src/shared/commands/registry.ts`): one dispatcher whose
  result type is a parameter, serving the desktop's sync handlers and VS
  Code's programs alike.

## Already settled, left alone

- Plugin hooks and fact-kind hooks with one implementer (`agentBlock`,
  `decision`, `requires`; `FactKind.accepts`/`supersedes`, only
  `shared/plugins/externalInquiry.ts`): the SDK surface, per the options
  inventory's "Rejected"
  (`.agents/docs/proposed/simplification/2026-11-03-fewer-processing-options.md`).
- `ITool.launchesTasks` (one implementer, `DocumentTaskTool.ts:127`; read at
  `delegationAvailability.ts:63`): the harness reads "an agent has a
  plugin's block" as data and names no plugin. Kept.
- `ITool.describe` (one implementer, the script tool): its text is genuinely
  computed from the step's tools.
- `ToolGuard.command.cwd: 'unknown'` (3 implementers) and `grant: 'bash'`
  (the shell). Each is a fact about its tool.
- `StartOptions.apiKeys` (only the CLI, through the service) and
  `followUp.send.holdUntil: 'turn'` (only the TUI): each is a public request
  field with one general meaning (a terminal's environment; read at turn
  end).
- `OpenOptions.persistent`: Rejected in the options inventory.
- The setup and Lean ports' optional members and VS Code-only rows: H8 and
  H9 (`../2026-11-06-design-red-flags-round-2/H-app-tools.md:555-606`).
  Finding 3 cites them, with a new angle.
- `createTrackedSignalRegistry` (one user; J5 deletes it) and
  `createCachedBinaryResolver` (H: `Effect.cachedWithTTL`). These were the
  strongest "general helper with one user" instances found; both are known.
- `WORKBENCH_KIND_META` and the two dock menus' subsets: U, "two facts".
  Finding 6 adds behaviour to the table, not a third list.
- `BaseRequestPanel`'s hooks filled by one subclass: J
  (`../2026-11-06-design-red-flags-round-2/J-ui-kit.md:764-766`).
- `codingPlanForUsageRoute` / `codingPlanForUsageSetting` (texra): two
  lookups keyed by two different facts (the usage route; the region
  setting). They are not one decision.

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

| Finding | Hand-rolled today                                                                                                                                                                              | Effect primitive and the exported API verified                                                                                                                                                                                                                                                                                | Why it fits                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1       | name tables (`TOOL_DISPLAY_KIND`, `TOOL_PREVIEW_INPUT_KEY`, `TOOL_LABEL`), 9 name matchers, `isEditLikeToolName` substrings, `TexraPlugin.icons`/`terminalOutput` through `HostSnapshot.tools` | `Schema.Literals` (`dist/Schema.d.ts:4188`) for `ToolDisplayKind`; `Schema.optionalKey` (`:1974`) for `tool.start.display`; `Schema.Struct` (`:3026`); the builders as a TS `Record<ToolDisplayKind, Builder>` with `satisfies`                                                                                               | a declaration is data on the row, decoded once; an exhaustive record replaces a matcher list. No runtime primitive is needed. |
| 2       | `MessageHost` + `PromptHost` (7 members), VS Code option names, `NotificationFailed.member`, five log-and-drop catches                                                                         | `Context.Service` (`dist/Context.d.ts:196`) for `Dialogs`; `Effect.logWarning` (`dist/Effect.d.ts:19019`) inside `notify`, so its error channel is `never`; `Schema.TaggedError` (`dist/Schema.d.ts:11985`) for the one `DialogFailed`; the CLI keeps its one-dialog lane, `Semaphore.makeUnsafe` (`dist/Semaphore.d.ts:217`) | a failure every caller logs and drops is logged once where it happens; a service per surface, not a mirror of one host's API  |
| 3       | `installsExtensions` boolean threaded through 3 layers, `latexEditorStatus` sentinels, 3 `unsupported` handlers, the frontend's `desktopHost` tests                                            | `Context.Service` (`dist/Context.d.ts:196`) `EditorIntegration`, provided by the VS Code root with `Layer.succeed` (`dist/Layer.d.ts:839`); readers use `Effect.serviceOption` (`dist/Effect.d.ts:11816`) and `Option.isSome` (`dist/Option.d.ts:364`)                                                                        | the presence of a service is the capability; no flag and no refusal row                                                       |
| 4       | `ToolEnv.run?`, `requests?`, `RunCall` as `Context.Reference` with a `null` default (`dist/Context.d.ts:1741`), `noRunChildRuns`, `requireRun`'s refusal                                       | a required `Context.Service` (`dist/Context.d.ts:196`) for `RunCall`, provided at the one dispatch site with `Effect.provideService` as today; required fields on `ToolContextShape`                                                                                                                                          | a default stands for "absent"; here nothing in production is absent, so the type should not say it can be                     |
| 5       | four setters and a set/clear pair over one union                                                                                                                                               | `Effect.fn` (`dist/Effect.d.ts:18880`) for `select`, a plain `switch` on `kind` (pure); optionally `Schema.TemplateLiteralParser` (`dist/Schema.d.ts:2423`) for the CLI's `team:<id>`                                                                                                                                         | one operation over one union; the side effects stay inside the lane the controller already serializes                         |
| 6       | about 28 `kind ===` branches across six functions; the document set twice                                                                                                                      | none: a plain TS table `satisfies Record<WorkbenchKind, PaneKind>` (the renderer is DOM code, not Effect)                                                                                                                                                                                                                     | the behaviour joins the table that already holds the kind's identity                                                          |
| 7       | `source: Schema.Literal('github')`                                                                                                                                                             | `Schema.String` (or the field dropped); decoding of stored rows is unchanged                                                                                                                                                                                                                                                  | a plugin id is data the harness stores, as `PluginRequestSchema.plugin` already is                                            |

Corrections made while verifying: there is no `Layer.scoped` in 4.1.2.
`Layer.effect` (`dist/Layer.d.ts:1166`) is the scoped form, and no finding
here needs one. `Context.Reference` takes `{ defaultValue: () => Service }`
(`dist/Context.d.ts:1741-1743`). Finding 4 removes exactly that default.
