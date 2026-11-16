# LS: shallow module, pass-through, overexposure (whole repo)

Read on `main` at `d70ad92`. The working tree at `9665c61522` adds only
audit reports. This is a read-only audit; the only file written is this
report.

**A thin lens, said plainly.** Since the last two lens audits
(`../2026-11-07-design-red-flags-lenses/pass-through.md`, PT1 to PT6, and
`../2026-11-08-design-red-flags-lenses-2/README.md` sections 4 and 6, L2-4
and L2-6), these three flags have been cut hard. #14936 and #14956 dropped the
entry exports with no embedder. #14941 and #14959 landed the L2-4 chains.
PT1 to PT6 are landed, and the tree confirms it: `ToolRun.apiKeys` is gone,
`makeSessions` takes `AgentCatalog`, `CliInvocation` replaces the
`CliContext` parameter, and so on. A whole-repo scan now finds very few pure
forwarders, and most of the ports left have a second implementation or a
reason to exist. Three findings survive; the rest are listed under "Dropped"
and "Already settled".

## Numbers

Lines (`.ts`/`.tsx` under `src/`): harness 79,150; texra 81,527; cli 44,932;
extension 15,758; desktop 14,491; llm 12,094; trace-viewer 407.

Five largest production files: `harness/src/shared/session/sessionViewUpdate.ts`
1,078; `harness/src/agent/runtime/loop/toolUseDispatch.ts` 1,011;
`cli/src/chat/chatSessionController.ts` 1,007; `desktop/src/renderer/main.ts`
936; `harness/src/agent/runtime/runRegistry.ts` 887.

How I measured. I used scripts in the scratchpad: a regex index of imports
with tsconfig alias resolution, and a TypeScript-AST pass using the global
`typescript`. They measured:

- **Exported declarations:** 4,843 (harness 1,868, texra 1,509, cli 836,
  llm 275, desktop 212, extension 135, trace-viewer 8).
- **Exports no file imports by name:** 109. After discounting entry points,
  Lit custom elements registered by side effect (23 extension, ~45 texra
  `ui/progress/components`), namespace and dynamic imports, and types named
  in exported signatures, about 10 remain. TC-8 and TC-11 report them, or
  they are types a public signature names.
- **Exports whose only importers are tests:** 25. All of them are in
  `../2026-11-07-design-red-flags-round-5-tests/2-code-for-tests.md` §6.
- **Modules with no production importer:** 10. Eight are entry points, one
  is `texra/src/platform/disposable.ts` (TC-11a), and one is the
  `ui/progress/index.ts` webview entry.
- **Pure renames** (a function whose body passes its own parameters, in
  order, to one call): 36. Most add a name, a key or a narrowed type.
- **Objects or classes whose members mostly forward:** 3 at the strict bar
  (same arguments). The other 22 at the loose bar are dispatch tables and
  host adapters.
- **Harness services provided at one production site:** 56. Nearly all are
  session-owned services with several readers, or ports another package
  serves.

---

## LS-1: The Overleaf clone workflow reports each outcome twice, through a 12-member port of callbacks and through a returned status, and each host writes all twelve

- flags: shallow module, conjoined methods, pass-through, overexposure
- package: texra (`latex/overleafClone.ts`); touches cli (`commands/clone.ts`), extension (`commands/git/gitCommands.ts`), and `packages/texra/test/latex/OverleafClone.vitest.ts`
- kind: refactor
- size: M
- earlier: none. LI-2 covers this module's `runGit` as a second git runner; that is a different fact, and the two changes do not collide.
- open PR: none (no open PR touches the three files)

**Evidence.**

- `OverleafCloneWorkflowPorts` (`packages/texra/src/latex/overleafClone.ts:38-72`)
  has 12 members. Four are capabilities: `secrets`, `promptToken`,
  `listWorkspaceEntries` and `runClone`. Eight are presentation:
  `showInvalidToken`, `showGitMissing`, `showWorkspaceUnreadable`,
  `showWorkspaceNotEmpty`, `showCloneSucceeded`, `showAuthFailure`,
  `showCloneFailed` and `logCloneError`.
- The workflow is about 90 lines of decisions
  (`resolveOverleafToken` `:94-120`, `checkOverleafClonePreconditions`
  `:122-154`, `cloneOverleafProject` `:273-317`). At each exit it calls one
  presentation port and then returns the same fact as
  `OverleafCloneOutcome` (`:74-82`). Examples: `ports.showGitMissing()`
  followed by `return { status: 'gitMissing' }` (`:134-135`), and
  `ports.showWorkspaceNotEmpty()` followed by `return { status: 'workspaceNotEmpty' }`
  (`:150-151`). The same pattern holds at `:114`, `:303`, `:305` and
  `:311`.
- The two hosts use the two channels differently:
  - The extension discards the status. `yield* runOverleafClone(...)`
    (`packages/extension/src/commands/git/gitCommands.ts:227-236`) reads no
    result, so the eight callbacks (`:121-201`) are its whole presentation.
  - The CLI uses both. Its eight callbacks (`packages/cli/src/commands/clone.ts:35-146`)
    write the messages, and a second `switch (outcome.status)` (`:198-212`)
    maps the same outcomes to exit codes. `'cancelled'` is the one outcome
    with no callback, so the switch writes its message itself (`:201-203`).
- Port members that carry nothing the host does not already have, or that
  a host ignores:
  - `showCloneFailed(message)` is always called with the constant
    `'Clone failed. Check credentials and connection.'` (`:305-307`).
  - `showInvalidToken(spec, message)` gets a `spec` the CLI ignores
    (`clone.ts:61`, `(_spec, message)`).
  - `showWorkspaceUnreadable(error: unknown)` is typed `unknown`
    (`overleafClone.ts:58`).
  - `showCloneSucceeded(label)` passes a label built from
    `remote.isOverleaf`, and both hosts already hold `remote`.
  - `logCloneError` is a second failure callback beside
    `showCloneFailed` / `showAuthFailure` (`:311`).
- The suite builds a 12-stub port to test the workflow
  (`OverleafClone.vitest.ts:20-43`), so the port's width is pinned by test
  too.
- Consumers: `OverleafCloneWorkflowPorts` has 2 production implementers and
  1 test. `cloneOverleafProject` has 2 production callers and 1 test.

**The design decision behind it.** The question is: who turns a clone's
outcome into words? The module answers it twice. It says "the host, through
a callback at the moment it happens" and also "the host, from the returned
status". So every host renders each outcome in a callback, and the CLI
renders it a second time in a switch. The module header calls the ports
"every side effect"; most of them are messages.

**The better design.** The workflow keeps the four capabilities and returns
one tagged outcome that carries what a renderer needs:

```ts
type OverleafCloneOutcome =
  | { _tag: 'Cloned' }
  | { _tag: 'Cancelled' }
  | { _tag: 'InvalidToken'; message: string; spec: OverleafTokenSpec }
  | { _tag: 'GitMissing' }
  | { _tag: 'WorkspaceUnreadable'; error: Error }
  | { _tag: 'WorkspaceNotEmpty' }
  | { _tag: 'AuthFailure'; error: string }
  | { _tag: 'CloneFailed'; error: string };
```

Each host then writes one `presentCloneOutcome(remote, outcome)`: a
`Match.tagsExhaustive` (or `switch`) that holds today's eight bodies. The
CLI's exit-code mapping becomes part of that one function. The port shrinks
to `{ secrets, promptToken, listWorkspaceEntries, runClone }`.

What is deleted:

- 8 port members and their 8 + 8 host implementations;
- the CLI's separate `switch` (folded into its presenter);
- the constant `showCloneFailed` argument;
- 7 of the 12 test stubs. The suite asserts on the returned outcome instead
  of on which spy ran, and that is the more stable boundary.

**What we give up, and risk.** The token-invalid message is shown after the
workflow returns instead of before, and nothing follows it, so nothing
observable changes. The extension's interrupt-on-cancel stays: the prompts
and the subprocess are still ports.

**How I tried to refute it.**

- I looked for a third host that renders in the callbacks: none. Desktop
  has no clone.
- I checked whether a callback is ever needed mid-flow, for example to show
  something before a later step. Every presentation call is the last effect
  on its path before a `return`, except `showAuthFailure`, which follows a
  `secrets.delete` the workflow keeps.
- I grepped the evidence folders, `proposed/` and `refuted-candidates.json`
  for `OverleafCloneWorkflowPorts`, `showGitMissing` and
  `showWorkspaceNotEmpty`. The only hits are test-tier notes in round 5 and
  LI-2's runner item.

---

## LS-2: The CLI status bar names a run grant with its own one-consumer table in the shared copy, in different words and in the reverse order from every other surface, under a comment saying all three hosts share it

- flags: shallow module, information leakage, repetition, comment restates code (a false comment)
- package: texra (`ui/copy/approvalBypass.ts`); touches cli (`chat/tui/panes/statusBarDisplay.ts`)
- kind: bug (the comment is false, and one grant gets two names on one host)
- size: S
- earlier: none. U (round 3, `U-cross-package.md:339-400`) treated `RUN_GRANT_NOUN` and its order and does not mention this table.
- open PR: none

**Evidence.**

- `APPROVAL_BYPASS_BADGE` (`packages/texra/src/ui/copy/approvalBypass.ts:8-12`)
  is `{ superYolo: 'AUTO-TASK', bash: 'AUTO-BASH', toolEdit: 'AUTO-EDIT' }`.
  Its comment (`:3-7`) says "CLI status-bar badges and the extension/desktop
  run-toolbar toggles share these so the three kinds stay named the same
  way". That is false. Its one importer is
  `packages/cli/src/chat/tui/panes/statusBarDisplay.ts:41`, and no file in
  `packages/texra/src/ui/progress`, desktop or extension mentions it or the
  strings.
- The app's real owner for these names is `RUN_GRANT_NOUN`
  (`packages/texra/src/ui/copy/delegationApproval.ts:14-18`: edits,
  commands, agent work). Its comment says the cards, the header chips "and
  the CLI's `/status` name the same grant with the same noun". The progress
  view's chips read `RUN_GRANT_COPY.label` = `Auto: edits`
  (`runGrantChips.ts:63`). The CLI itself uses `RUN_GRANT_NOUN` in
  `/status` (`chat/tui/sessionStatus.ts:114`), `/approval`
  (`approvalCommand.ts:53`), the policy form (`ApprovalPolicyForm.tsx:37`)
  and the confirm card (`ConfirmCardState.ts:102,147`). So one CLI session
  calls the same grant "AUTO-TASK" in the status bar and "agent work"
  everywhere else.
- Order. The status bar keeps its own list, `BYPASS_BADGES`
  (`statusBarDisplay.ts:580-600`): superYolo, bash, toolEdit.
  `RUN_GRANT_ORDER` ("the one order grants are listed in on every surface",
  `delegationApproval.ts:20-24`) runs toolEdit, bash, superYolo.
- `packages/texra/src/ui/README.md:96-98`: "Words come from `copy/`. One name
  per concept across hosts."

**The design decision behind it.** The question is: what is this grant
called, and in what order are grants listed? `delegationApproval.ts`
answers it for every surface. A second module answers it for one widget.

**The better design.** The status bar maps `RUN_GRANT_ORDER` to
`RUN_GRANT_COPY.label(kind)`, or an upper-case compact form added beside
`compactLabel` if the bar needs the short shape. It keeps only the colour
per kind locally (`badgeColor` is presentation the CLI owns). Delete
`approvalBypass.ts` (1 importer) and the `text` column and order of
`BYPASS_BADGES`.

**What we give up, and risk.** The status bar's wording changes from
`AUTO-BASH` to the shared label. `packages/cli/scripts/validate-tui.mjs`
expects `AUTO-BASH` at `:972`, `:1617`, `:1643` and `:1672`, and those four
expectations change with it. `:1672` already expects both vocabularies on one
screen: `'auto-approvals: commands', 'AUTO-BASH'`. The badges are
`policy: 'keep'` segments in a width-fitted row (`statusBarDisplay.ts:807-818`),
so the label should be short. A compact form beside
`RUN_GRANT_COPY.compactLabel` (for example `AUTO: COMMANDS`, or the noun
alone) keeps the row's budget.

**How I tried to refute it.** I looked for the extension and desktop
toolbar toggles the comment names. The progress view's grant chips use
`RUN_GRANT_COPY`, so they share nothing with this table. I checked whether
the badge needs a fixed shape for layout. It is a coloured text segment kept
during fitting (`:807-818`), so any short label fits the same way.

---

## LS-3 (batched, small): Two renames that add a name and nothing else, one of them on the public surface

- flags: shallow module, overexposure, pass-through
- package: harness; touches extension
- kind: refactor
- size: S
- earlier: none
- open PR: none

**Evidence and fix.**

- **a. `JsonValueSchema = Schema.Json`**
  (`packages/harness/src/shared/schemas/jsonValue.ts:8`), exported on
  `@texra-ai/harness/schemas` (`schemas.ts`, shipped in `docs/api/schemas.md`).
  - Its comment calls it a "shared home for `Schema.Json` so structured
    tool output, script results, and agent run results validate the same
    contract instead of re-declaring it". But `Schema.Json` is already one
    declaration, and the root `AGENTS.md` ("JSON is `Schema.JsonObject` /
    `Schema.Json`") tells contributors to use Effect's.
  - The two spellings coexist: `JsonValueSchema` in 11 production files,
    `Schema.Json` directly at `texra/src/controllers/server/hostCalls.ts:139`
    and `service.ts:348`.
  - Fix: delete the alias and the `JsonValue` type, and write `Schema.Json`
    and `Schema.Json['Type']`, or Effect's own type name if one is exported.
    `toJsonValue` (`:12-15`), which has real behaviour, stays in the
    file. The decoded type is unchanged, so persisted rows are unaffected.
- **b. `resetSettingsState()`**
  (`packages/extension/src/settingsView/frontend/settingsState.ts:159-161`)
  is `resetTrackedSignals()`, the destructured `resetAll` of the registry
  built at `:41`. It has 1 caller (`SettingsApp.ts:65`). Fix: export
  `resetAll` under that name, or call the registry's `resetAll` at the one
  site; the comment block at `:155-158` moves with it.

**How I tried to refute it.** I checked the other pure renames the AST scan
found and kept them out:

- `callChildRunId` narrows `RunIdFields` to the four fields a call's child
  is derived from.
- `textDisplayWidth`: L2-6 left it, with 11 files.
- `exposeApiKey`: a documented choke point.
- `isAllowedLatexInstallCommand` and similar `SET.has` wrappers name a
  policy.
- `actionButtons`' four wrappers: J-ui-kit "the names are the API".
- `readCliCwd` and `runCliExit`: lint-allowlisted process and runtime
  access.

---

## Good modules in this area

- **`LatexProgress`** (`packages/texra/src/latex/progress.ts:9-13`). This is
  the `Context.Reference` that L2-4 proposed for the arXiv `progressCallback`
  chain, landed. It defaults to a no-op, the extension provides it once
  (`arXivCommands.ts:107`), and the two deep readers yield it. Copy it for
  any "optional host sink".
- **`withZoteroPort`'s removal.** The Zotero transports read the port from
  `ToolContext` (PT5 landed). No tool program threads it now.
- **`rootedFileSystem`** (`harness/src/utils/files/rootedFileSystem.ts:216`).
  It is the one object where 20 of 26 members forward, and every forward adds
  root confinement. This is a decorator done right, already settled in PT.
- **Harness entry discipline.** After #14936 and #14956, every value on the
  six harness entries without an in-repo importer is a tagged error class
  that an `Effect` error channel in a public signature names
  (`PluginsRefused`, `SessionOptionsConflict`, `AgentNotFound`,
  `RouteRetries`' shape, …). None is dead.

## Already settled, left alone

- **The settings view's frontend living in the extension package, imported
  by the desktop**, with five `@ui` modules that only it reads
  (`settingsSection`, `settingsBanner`, `tablistKeyboardNav`,
  `DetailsOpenController`, `lightweightMd`): EX-5.
- **`latexPreamble` and `resourcesPath` threaded from both GUI hosts
  through `GuiWindowHost.export` to the chat export:** EX-2.
- **`DesktopAttentionPort`, a desktop port with one implementation and no
  test:** DT (`DT-desktop.md:510-526`).
- **The progress view's roots, runtime and global-state threading:** EX-8.
  **The chat TUI's runtime, stores and roots as props:** CL-5.
- **The extension's `globalState` threaded into the Lean integration
  (`frontend/lean/VscodeIntegration.ts:229-529`), `initializeLatexSupport`
  and `promptExtensionInstall`.** The AST scan finds 10 of 11
  `StateStore` parameters in the extension only forwarded. Its readers are
  `Settings` reads, which take the stores as data by design.
  `PLATFORM-roots-drop-global-slots` (`refuted-candidates.json`) refused
  moving them to the context. Reported again only with evidence that
  refusal lacked; I have none.
- **`SettingsStores` / `WorkspaceRoots` as data** (20 of 22 texra and 23 of
  27 cli `SettingsStores` parameters only forwarded): PT "Already settled",
  `shared/config/settings.ts:17-23`.
- **Test-only exports** (`RunRegistryInit`, `ResumeRunOptions`,
  `decodeXmlEntities`, `SessionViewUpdater`, `injectStandaloneTrace`,
  `GitHubRateLimitError`, `GitCloneFailed`, `FLUSH_INTERVAL`, the llm model
  factories, …): round-5 tests `2-code-for-tests.md` §6, which held them
  until the suites move to stable boundaries.
- **`getIncludedExtensions`** (L2-6.4 remainder) is kept for its three host
  callers by the catalogue's own note, and `packages/texra/AGENTS.md` names
  it as the app's policy entry.
- **`OverleafCloneWorkflowPorts`' `runGit`** as a second git runner: LI-2.

## Dropped on verification (14)

1. The 109 unimported exports, beyond the categories above. The
   file-local-only ones are `PastedImageEntry`, `DecisionSurface`,
   `TuiHostInteractions`, `RouteCredential` and `TakenFollowUp`. Each is
   named by an exported function's signature or an exported type's field,
   so a published or cross-file caller can name it.
2. `MissingLatexTool`, `InstallCommand`, `EventInput` and `HostFrameSchema`:
   TC-11.
3. `ChatExportInputUnreadable`, `ChatExportLoadResult` and
   `ChatExportInputSchema`: TC-8.
4. `@texra-ai/llm` root values `DEFAULT_MODEL_CAPABILITIES` and
   `TurnRequestSchema` with only test importers: covered by round-5 tests,
   and `TurnRequest` is a documented embedder type.
5. `servesWebSocket`, `openaiResponsesWebSocketModel` and
   `forcedToolChoice`: consumed through `llm/src/node.ts`'s namespace and
   dynamic imports.
6. `ui/copy/runHistory.ts` and `ui/copy/interruptedTasks.ts`, CLI-only
   modules in the app: the UI README's "Words come from `copy/`" rule puts
   them there.
7. `latex/latexToolchain.ts` (CLI `doctor` only): a probe over the app's
   own toolchain table. Moving it to the CLI would make the CLI restate the
   compiler rule.
8. `teamLaunch.ts`' six CLI-only exports: the module is shared. GUI hosts
   read `loadTeamOptions` and `resolveTeamLaunch` from it.
9. `WorkspaceAgentsController` (9 of 12 members single calls): a real class
   over its deps, and HS covers it.
10. `AppState.layer`'s forwarding object (`platform/interfaces.ts:36-41`):
    it adapts a `StateStore` to the service and adds `changes`, which M8
    settled.
11. `SetupPlatform` / `SetupHost` / `InlineComments` / `EditorHost`: ports
    with host-varying implementations or deliberate absence.
12. `harness` `HostCapabilities` (one provider, in texra): a plugin
    contract the harness reads with `Context.get`, and the boundary it
    marks is the point.
13. `callChildRunId`: it narrows the input type (see LS-3).
14. The `LatexdiffHost`, `TranscriptExportHost` and
    `ProgressDocumentTaskFileActionsHost` ports named only in
    `openGuiWindow.ts`: they are pieces of the window composition that
    TC-1 and EX-2 already cut.
