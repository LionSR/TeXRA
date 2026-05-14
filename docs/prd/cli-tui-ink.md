# PRD: TeXRA CLI Ink-based TUI

## Status: Draft

## 1. Summary

Replace the `texra chat` plain-ANSI line renderer with an Ink-based TUI that mirrors the VS Code Progress View's component topology, reuses the workspace's existing markdown and syntax-highlighting pipelines, and lets a keyboard-only user drive multi-agent sessions with the same fidelity they get in the extension.

The headless path (`texra run`, `--print/-p`, `--output-format json|ndjson`, non-TTY, CI) is preserved byte-for-byte. The new TUI runs only when the chat command is invoked on an interactive terminal.

## 2. Problem

`texra chat` today (`packages/cli/src/chat/runChat.ts`, `terminalRenderer.ts`) is a structured logger to stderr. Three concrete consequences:

1. **Concurrent agents are invisible.** `updateActiveSubagents` and `updateActiveProcesses` collapse to one muted line ("subagents: 3 active"). The webview's `BackgroundTasksPanel` renders one row per child with click-to-switch; the CLI renders a counter.
2. **Approvals interleave with the model stream.** A bash or edit approval prints a card, the model keeps streaming on top of it, and the user types `y` / `n` at a prompt that has scrolled off-screen. The webview opens a modal that blocks the conversation pane.
3. **Keyboard ergonomics stop at slash commands.** Multiline drafts require `/multi` → `/send`. No history, no autocomplete, no panel switching, no file mentions, no command palette. Modern AI CLIs (Claude Code, Codex CLI, Gemini CLI, Aider) all ship these out of the box.

The CLI is also rebuilding wheels — manual arg parsing, ANSI constants, stream-drain logic, multiline state machine, follow-up promise chain, log-diff dedup, ASCII card rendering — none of which need to exist in 2026.

## 3. Goals

- G1. Render every event the webview's Progress View renders, at parity, in the terminal.
- G2. First-class multi-agent UX: one row per active subagent / process, keyboard switching, per-child stream focus.
- G3. Keyboard-driven: every operation reachable without slash commands. Slash commands stay as aliases.
- G4. Reuse the workspace's markdown / shiki / signals stack — one rendering pipeline, two hosts.
- G5. Delete ~400 LOC of hand-rolled rendering and plumbing in `packages/cli/` in favor of established libraries.
- G6. Zero regression in headless behavior. `texra run --output-format ndjson` output byte-identical.

## 4. Non-goals (explicitly excluded)

- Mouse support, theming, persisted TUI session state on disk (beyond input history).
- Replacing the webview's Lit components or the desktop shell.
- Remote / cloud session attach (separate effort).
- A second `StreamTabId` model — `@shared/schemas/identifiers` is the only one.
- Markdown→ANSI written from scratch (the workspace already has a markdown-it pipeline; we wrap it).
- A second state-management library — `@lit-labs/signals` is already in the workspace.
- New approval surfaces, new agent types, new commands beyond what `chat` already exposes.

## 5. Tech stack (locked)

Every dependency is either already in the workspace, used by the dominant 2026 AI CLIs, or replaces an existing hand-rolled utility. Nothing is speculative.

### Runtime & framework

| Concern          | Package                                                             | Rationale                                                                                                                  |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| TUI framework    | `ink` 6 + `react` 19                                                | Claude Code, Codex CLI, Gemini CLI, Wrangler, Astro all on Ink. Yoga flexbox. ESM-native. `<Static>` preserves scrollback. |
| Component kit    | `@inkjs/ui`                                                         | Official. Spinner, Select, MultiSelect, TextInput, ConfirmInput, Alert, ProgressBar, UnorderedList, Badge.                 |
| Focus & keys     | Ink built-ins (`useInput`, `useFocus`, `useFocusManager`)           | No external keybinding library needed.                                                                                     |
| State inside Ink | `@lit-labs/signals` + a `useSignal` bridge (`useSyncExternalStore`) | Same primitive the webview's `progressState` uses. Shared mental model.                                                    |
| Bundler          | `esbuild` (existing)                                                | Already wired in `packages/cli/scripts/build-bundle.mjs`.                                                                  |

### Inputs & one-shot prompts

| Concern                          | Package                                                           |
| -------------------------------- | ----------------------------------------------------------------- |
| CLI argument parser              | `citty` (UnJS)                                                    |
| One-shot prompts outside TUI     | `@clack/prompts`                                                  |
| Inline TUI input                 | `ink-text-input` (+ our own autocomplete on `@inkjs/ui` `Select`) |
| Fuzzy match (palette / file `@`) | `fzf-for-js`                                                      |
| Input history persistence        | `platform().storage` → `~/.texra/history.jsonl`                   |

### Rendering (shared with webview where possible)

| Concern                     | Source                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Markdown                    | `markdown-it` + `markdown-it-texmath` (reuse webview's `markdownRenderer.ts`, with an ANSI rule plugin added for the CLI host) |
| Syntax highlighting         | `shiki` via the existing `@shared/highlighting` module, using `shiki/ansi` themes                                              |
| Math `$...$`                | `unicodeit` fallback for inline; block math passes through raw in v1                                                           |
| Diffs                       | `diff` for hunks + shiki/ansi for line coloring                                                                                |
| Hyperlinks                  | `terminal-link` (OSC 8) for clickable paths                                                                                    |
| ANSI-safe truncation / wrap | `string-width` + `wrap-ansi`                                                                                                   |

### Plumbing

| Concern                          | Package                                   |
| -------------------------------- | ----------------------------------------- |
| Serial follow-up queue           | `p-queue`                                 |
| Colors (legacy renderer only)    | `picocolors`                              |
| Clipboard ("copy last response") | `clipboardy` (with OSC 52 fallback)       |
| Tests                            | `ink-testing-library` + existing `vitest` |

### Deliberately omitted

`chalk` (picocolors suffices), `commander` (citty is leaner and ESM-first), `inquirer` (@clack/prompts replaces it), `marked-terminal` (we reuse the markdown-it pipeline), `cli-highlight` (shiki is strictly better and already in the repo), `boxen` (Ink `<Box borderStyle>`), `ora` (`@inkjs/ui` Spinner), `ink-tab` (Ink 6 focus mgmt suffices), `zustand` / `jotai` / `xstate` (signals already in workspace).

## 6. Wheels to drop

Each entry is a deletion candidate, not a wrapper.

| Today                                                                                                         | Where                                | Replace with                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- | ------------------------------- |
| `splitGlobalArgs`, `splitRunArgs`, `flagValue`, `cliFlagName`, `hasBooleanFlag`, four `FLAGS_WITH_VALUE` sets | `cliContext.ts:44–166, 224–268`      | `citty` `defineCommand`                                                 |
| `ANSI_TONES`, tone-switching `write()`                                                                        | `terminalRenderer.ts:20–27, 546–552` | `picocolors` in legacy; Ink `<Text color>` in TUI                       |
| `truncateText`, `formatOutputSnippet`, `formatUnknownSnippet`                                                 | `terminalRenderer.ts:61–64, 310–367` | `string-width` + `wrap-ansi`                                            |
| `renderedToolUseSignatures` `JSON.stringify` dedup                                                            | `terminalRenderer.ts:181–183`        | `useSyncExternalStore` + React `memo` keyed on `entry.id + entry.seqNo` |
| `MultilineDraftState` + `/multi` `/send` `/cancel` plumbing                                                   | `runChat.ts:63–66, 451–469, 507–511` | `ink-text-input` with `Ctrl-J` newline; `/multi` retained as alias      |
| `followUpFlush` promise chain, `pendingFollowUps`, `flushPendingFollowUps`, `streamReadyForFollowUps`         | `runChat.ts:58–61, 255–304`          | `p-queue` (`concurrency: 1`)                                            |
| `askCliQuestion`, `createCliLineReader`                                                                       | `logSinks.ts:87–107`                 | `@clack/prompts` outside TUI; Ink inside                                |
| `NdjsonStdoutSink.drain`, `waitForStdoutDrain`                                                                | `logSinks.ts:121–196`                | Node 22 streams; not reused inside TUI                                  |
| `installChatResponsePrinter` log-diff loop                                                                    | `runChat.ts:109–141`                 | `useStreamLog(streamId)` hook + `<Static>` for finalized turns          |
| ASCII `-- title --` / `                                                                                       | line` cards                          | `terminalRenderer.ts:513–524`                                           | Ink `<Box borderStyle="round">` |

Net: ~400 LOC deleted across `terminalRenderer.ts`, `runChat.ts`, `cliContext.ts`, `logSinks.ts`; replaced by ~120 LOC of provider + hook glue.

## 7. Architecture

The webview already does this. We're cloning its topology, not inventing.

```
ProgressEventBus  ─┐                (src/eventBus/ProgressEventBus.ts:60–227)
StreamLogStore    ─┼─► signals state ─► React components (Ink)
StreamStatusSvc   ─┘  (@lit-labs/signals,    │
                       same shape as webview's    ├── <Static> for finalized turns
                       progressState.ts)         └── live <Box> for in-flight turn

Approval coordinators ──► approvalQueue signal ──► <ApprovalModal>
                                                    ├─► handleProgressViewBashApprovalAction
                                                    ├─► setToolEditApprovalHandler resolver
                                                    ├─► resolvePlanApproval
                                                    ├─► resolveProposal
                                                    ├─► triggerRetry / cancelRetry
                                                    └─► handleExternalInquiryAction
```

One state model, two renderers. The webview uses `appState = signal(createInitialState())` (`progressState.ts:2`). The CLI declares an identically-shaped signal in `packages/cli/src/chat/tui/state/cliState.ts`. Both subscribe to the same bus and store. The components differ; the state slice does not.

```
packages/cli/src/chat/tui/
├── App.tsx
├── state/
│   ├── cliState.ts                 (@lit-labs/signals; mirrors progressState shape)
│   ├── useSignal.ts                (≈10-line useSyncExternalStore bridge)
│   ├── subscribeProgressBus.ts     (every ProgressEventBus event → signal patch)
│   └── subscribeStreamLog.ts       (StreamLogStore.onChange → signal patch)
├── panes/
│   ├── Header.tsx                  (agent, model, usage, status)
│   ├── ConversationPane.tsx        (<Static> + live <Box>)
│   ├── SubagentList.tsx            (updateActiveSubagents / updateActiveProcesses)
│   ├── TodosPlanPanel.tsx
│   ├── StatusBar.tsx               (yolo / bypass / queued-followup badges)
│   └── InputBar.tsx
├── modals/
│   ├── BashApproval.tsx
│   ├── EditApproval.tsx            (diff + shiki/ansi)
│   ├── PlanApproval.tsx
│   ├── AgentProposal.tsx
│   ├── RetryRequest.tsx
│   └── ExternalInquiry.tsx
├── render/
│   ├── ToolUseCard.tsx
│   ├── Markdown.tsx                (markdown-it + ANSI rule plugin)
│   ├── CodeBlock.tsx               (shiki via @shared/highlighting)
│   └── DiffView.tsx
├── commands/
│   ├── slashRegistry.ts            (reads from @agent + @model registries)
│   ├── palette.tsx                 (Ctrl-P, fzf-for-js)
│   └── fileMention.tsx             (@, platform().workspace.findFiles)
├── streams/
│   ├── streamTabs.ts               (reuses StreamTabId from @shared/schemas/identifiers)
│   └── focusCycle.ts               (Ctrl-A across active descendants)
└── history/
    └── inputHistory.ts             (platform().storage → ~/.texra/history.jsonl)
```

`runChat.ts` shrinks to: parse args (citty), init platform (unchanged), install approval handlers (unchanged), `render(<App/>)`. The multiline state, follow-up queue, log-diff loop, and approval prompting all move into the React tree or external libraries.

## 8. Multi-agent: `StreamTabId` is the only model

`StreamTabId` is already the shared identifier (`src/shared/schemas/identifiers.ts`). The webview's `progressState` keeps `streamById: Map<StreamTabId, StreamTabInfo>` with `activeStreamId` (`store.ts:66–79`). The CLI inherits that model unchanged.

- `cliState.streamById: Signal<Map<StreamTabId, StreamTabInfo>>` — populated from `setActiveStream`, `setParentStream`, `removeStream`, `updateStreamStatus`.
- `cliState.activeStreamId: Signal<StreamTabId>` — switched by `Ctrl-A` cycle, palette pick, or auto-follow on `setActiveStream`.
- `<SubagentList>` renders one row per descendant of the root stream, with status / model / elapsed / tokens. Number keys `1`–`9` jump focus. `Ctrl-A` cycles forward. `Ctrl-Shift-A` returns to parent.
- Detached children (`AgentExecutionHandle.detach()`, `ExecutionHandle.ts:104–106`) automatically appear as top-level tabs because the registry already re-fires `updateActiveSubagents` with the new linkage.
- No new `onChildStreamReady` hook required — we subscribe to `updateStreamStatus` and react when a `childStreamId` transitions `INITIALIZING → RUNNING`.

## 9. Approvals: modal queue replaces stderr prompts

`installCliApprovalHandlers` (`approvalAdapter.ts:268–270`) stays. Only the prompt path changes.

- `CliContext.approvalPrompt` becomes a function that pushes onto `cliState.approvalQueue` and returns a promise that the modal resolves.
- `<ApprovalModal>` reads the head of the queue, dispatches to the right sub-component, and on resolution calls the existing resolvers — exactly the same calls today's adapter makes.
- `--approval-policy never` and `--approval-policy yolo` short-circuit before reaching the queue (unchanged `immediateDecision` in `approvalAdapter.ts:89–94`).
- `<EditApproval>` renders unified diffs from `originalContent` + `proposedContent` (both already on `ToolEditPermission`) using `diff` + shiki/ansi. Keys: `y` approve, `n` reject, `e` reject-with-feedback (opens an inline `<TextInput>`).

## 10. Event → component map

Every signal source already exists.

| Event                                                              | Consumer                              | Render                                            |
| ------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------- |
| `updateStreamUsage`                                                | `<Header>`                            | tokens, cost, elapsed                             |
| `updateConversationProgress`                                       | `<Header>`                            | turn / tool counts                                |
| `updateStreamDescription`                                          | `<Header>`                            | session subtitle                                  |
| `StreamStatusService.onDidChange`                                  | `<StatusBar>`, `<InputBar>`           | status pill, prompt enabled                       |
| `StreamLogStore` (`MODEL_RESPONSE`)                                | `<ConversationPane>`                  | streaming text → `<Static>` on turn end           |
| `StreamLogStore` (`TOOL_USE`)                                      | `<ToolUseCard>`                       | header + status, expandable detail                |
| `updateActiveSubagents`                                            | `<SubagentList>`                      | one row per `ActiveChildInfo`, spinner, focus key |
| `updateActiveProcesses`                                            | `<SubagentList>` (processes section)  | one row per process                               |
| `updateProcessOutput`                                              | child stream view (on focus)          | stdout / stderr tail                              |
| `updateTodos`                                                      | `<TodosPlanPanel>`                    | checklist                                         |
| `updatePlan`                                                       | `<TodosPlanPanel>`                    | numbered steps, status                            |
| `setActiveStream`                                                  | `<App>` router                        | switch primary streamId                           |
| `setParentStream`                                                  | `<App>` router                        | nest child under parent                           |
| `removeStream`                                                     | `<App>` router                        | cleanup                                           |
| `updateQueuedFollowUps`                                            | `<InputBar>`                          | "queued: N" pill                                  |
| `updateToolEditApprovalBypassState` / `updateSuperYoloBypassState` | `<StatusBar>`                         | YOLO / BYPASS badge                               |
| `addOutputFiles`, `updateMissingOutputs`, `updateCompileFailures`  | `<WorkflowSidebar>` (workflow agents) | file list + diagnostics                           |
| `showBashPermission`                                               | `<BashApproval>`                      | resolver: `handleProgressViewBashApprovalAction`  |
| `showToolEditPermission`                                           | `<EditApproval>`                      | resolver: `setToolEditApprovalHandler` callback   |
| `showPlanApproval`                                                 | `<PlanApproval>`                      | resolver: `resolvePlanApproval`                   |
| `showAgentProposal`                                                | `<AgentProposal>`                     | resolver: `resolveProposal`                       |
| `showRetryRequest`                                                 | `<RetryRequest>`                      | resolver: `triggerRetry` / `cancelRetry`          |
| `showExternalInquiry`                                              | `<ExternalInquiry>`                   | resolver: `handleExternalInquiryAction`           |

## 11. Keymap

| Key                       | Action                                                  |
| ------------------------- | ------------------------------------------------------- |
| `Enter`                   | Send message                                            |
| `Ctrl-J`                  | Newline (kills `/multi` ceremony)                       |
| `Tab`                     | Autocomplete (file, slash, agent, model)                |
| `↑` / `↓`                 | History (input) / row navigation (lists, modals)        |
| `Ctrl-R`                  | Reverse history search                                  |
| `Ctrl-P`                  | Command palette                                         |
| `Ctrl-A` / `Ctrl-Shift-A` | Cycle active child / return to parent                   |
| `1`–`9`                   | Jump to subagent row                                    |
| `Ctrl-T`                  | Tab view (Conversation / Subagents / Todos+Plan / Logs) |
| `Ctrl-L`                  | Clear screen (scrollback preserved)                     |
| `Ctrl-C`                  | Interrupt active session; second tap exits              |
| `Ctrl-D`                  | Exit on empty input                                     |
| `Esc`                     | Close modal / palette / cancel inline edit              |
| `?`                       | Inline help overlay                                     |
| `y` / `n` / `e`           | Approve / reject / reject-with-feedback                 |
| `@`                       | File-picker autocomplete                                |
| `/`                       | Slash-command palette                                   |

## 12. Rendering parity with the webview

| Concern         | Webview                                            | CLI TUI                                                          |
| --------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| Markdown        | `markdown-it` + `markdown-it-texmath` w/ LRU cache | Same `markdown-it` instance + thin ANSI rule plugin              |
| Code fences     | `shiki` via `@shared/highlighting`                 | Same module, `shiki/ansi` themes                                 |
| Math            | `katex` → HTML                                     | `unicodeit` for inline; block math raw in v1                     |
| Diff            | Monaco diff editor                                 | `diff` + shiki/ansi                                              |
| Tool cards      | Lit component per messageType                      | Ink component per messageType                                    |
| Subagent badges | `BackgroundTasksPanel.ts`                          | `<SubagentList>` (same data, same `setActiveStream` on activate) |
| Follow-up input | `FollowUpInput.ts` textarea                        | `<InputBar>` with `/` palette + `@` mention                      |

Two TUI features the webview does **not** have today:

1. Slash-command palette (`/agent`, `/model`, `/help`, `/status`, `/yolo`, plus registered tools).
2. `@`-mention file picker via `platform().workspace.findFiles`.

Pure additions; no contract change. They can later land in the webview behind the same registry.

## 13. Headless & legacy preserved

- `texra run`, `--print/-p`, non-TTY, `CI=true` — Ink never loads. `runChat.ts` already rejects headless chat; that gate stays.
- `--legacy-renderer` flag retains today's plain renderer (also auto-forced on `TERM=dumb` or `NO_COLOR` + narrow `COLUMNS`). The legacy renderer becomes the only consumer of `picocolors` after migration; everything else lives in Ink.
- `--output-format json|ndjson` output byte-identical. Golden test in `scripts/validate-run.mjs`.
- `<App>` uses `<Static>` for finalized turns; no alt-screen by default. `texra chat | tee transcript.log` keeps working. Matches Claude Code's behavior.

## 14. Migration phases

Every phase is independently mergeable. Each adds an `--tui` flag, default-off, until Phase 6.

**Phase 0 — Foundation (1 d).** Add `react@19`, `ink@6`, `@inkjs/ui`, `citty`, `picocolors`, `string-width`, `wrap-ansi`. Migrate `cliContext.ts` arg parsing to `citty` (no UI change). Drop `ANSI_TONES` for `picocolors` in legacy renderer. Verify headless tests + `validate-run.mjs` pass.

**Phase 1 — Skeleton (2 d).** Render `<App>` with `<Header>` + `<InputBar>` + `<ConversationPane>` (MODEL_RESPONSE only) behind `--tui`. Wire `cliState` signal + `useSignal` bridge. Subscribe to `ProgressEventBus` + `StreamLogStore`. Introduce `p-queue`-backed follow-ups. Approvals still on legacy path.

**Phase 2 — Tool & approval rendering (3 d).** `<ToolUseCard>`. All six approval modals fed by the queue. `<DiffView>` using `diff` + `@shared/highlighting`. Reuse the existing `installCliApprovalHandlers` resolver wiring; only the prompt path changes.

**Phase 3 — Markdown + code (1–2 d).** Lift the webview's `markdownRenderer.ts` into a shared `@shared/markdown` module (it's pure rendering, fits there). Add an ANSI rule plugin for the CLI host. Wire `<Markdown>` and `<CodeBlock>` into `ConversationPane`. Cold-load shiki grammars lazily.

**Phase 4 — Multi-agent + tabs (2 d).** `<SubagentList>`, `<TodosPlanPanel>`, `<StatusBar>`. `Ctrl-A` focus cycle. Stream switching via `setActiveStream`. Process output tailing.

**Phase 5 — Ergonomics (2 d).** `Ctrl-P` palette (`fzf-for-js`), `Ctrl-R` reverse history, `@` file picker, `/` command palette, autocomplete on `/agent` & `/model`. Input history at `~/.texra/history.jsonl` via `platform().storage`.

**Phase 6 — Stabilise & flip (1 d).** `--tui` defaults on for TTY; `--legacy-renderer` becomes opt-out. README rewrite. Decide `private: true` flip (separate). Smoke matrix: Windows Terminal, iTerm2, macOS Terminal, GNOME Terminal, tmux, screen.

Total: ~11 dev-days, six PRs.

## 15. Testing

- **Unit.** `ink-testing-library` renders each pane / modal against synthetic `ProgressEventBus` and `StreamLogStore` mocks. Snapshot the frame string.
- **Integration.** Extend `packages/cli/scripts/validate-run.mjs` with an interactive variant driving stdin via `node-pty` and asserting frame snapshots.
- **Approval flows.** Per-modal test that the right resolver is called with the right payload. Highest-risk wires.
- **Headless regression.** Existing `texra run` golden outputs unchanged. `--legacy-renderer` keeps the existing plain-mode tests green.

## 16. Risks

- **R1.** `markdown-it` runs in browser today; CLI use requires confirming no DOM dependencies in the existing renderer. _Mitigation:_ spike during Phase 3; fall back to `marked` + custom rule set if needed.
- **R2.** `shiki` cold-start cost (~50 ms to load grammars). _Mitigation:_ lazy-load on first code fence; cache loaded languages globally.
- **R3.** Lifting webview-side `markdownRenderer.ts` upward violates `packages/extension` → CLI direction. _Mitigation:_ move the module into `src/shared/` since it's pure rendering with no VS Code coupling.
- **R4.** Ink `<Static>` + `<Box>` interaction in tmux / screen. Established as workable by Claude Code; verify in smoke matrix.
- **R5.** Bundle size: react 19 + ink 6 + shiki grammars ≈ 1.2 MB. Acceptable for a CLI; flag at review.
- **R6.** Windows TTY edge cases (Ctrl-J = LF on some terminals, non-VT100 sequences). _Mitigation:_ test on Windows Terminal + ConHost; rely on Ink's key normalization.
- **R7.** Resource path resolution (`resolveResourcesPath` in `cliContext.ts:290–299`) changes once the package is published rather than linked. Tracked separately; not Ink-specific.

## 17. Success criteria

- Every event in §10 renders in the TUI with visible parity to the VS Code Progress View on the same agent run.
- A user completes a 3-subagent run, approves two edits, and rejects one bash command without typing a single slash command.
- `texra run --output-format ndjson` output byte-identical before/after.
- `texra chat --legacy-renderer` byte-identical to today.
- New runtime deps: `react`, `ink`, `@inkjs/ui`, `ink-text-input`, `citty`, `@clack/prompts`, `picocolors`, `string-width`, `wrap-ansi`, `p-queue`, `diff`, `fzf-for-js`, `terminal-link`, `clipboardy`, `unicodeit`. Plus existing `markdown-it` + `markdown-it-texmath` + `shiki` lifted into `src/shared/`. No others.

## 18. References

**CLI surfaces (current):** `packages/cli/src/runtime/cliContext.ts:44–268` · `packages/cli/src/chat/terminalRenderer.ts:20–367, 513–524` · `packages/cli/src/chat/runChat.ts:58–66, 109–141, 255–304, 451–511` · `packages/cli/src/runtime/logSinks.ts:87–196` · `packages/cli/src/runtime/approvalAdapter.ts:89–94, 268–270`.

**Webview reference topology:** `packages/extension/src/progressView/frontend/progressState.ts:2` · `packages/extension/src/progressView/frontend/store.ts:66–79` · `packages/extension/src/progressView/frontend/formatters/markdownRenderer.ts:6–53` · `packages/extension/src/progressView/frontend/components/{BackgroundTasksPanel,TexraDiffView,FollowUpInput,ToolEditRequestPanel,BashRequestPanel,ProposalRequestPanel,PlanApprovalRequestPanel,ExternalInquiryPanel}.ts`.

**Shared infrastructure:** `src/shared/schemas/identifiers.ts` (`StreamTabIdSchema`) · `src/agent/runtime/{StreamStatusService.ts:33–72, ExecutionHandle.ts:104–106, executionRegistry.ts:32–205}` · `src/eventBus/ProgressEventBus.ts:60–227` · `src/logger/{StreamLogStore.ts:95–114, AgentLogger.ts:130–587, structuredLogger.ts}` · `src/platform/platform.ts` + `defaults/` · `docs/pocketflow/`.
