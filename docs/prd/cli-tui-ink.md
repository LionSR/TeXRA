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
- G4. Reuse the workspace's markdown (`markdown-it`) and highlight.js (`@shared/highlighting`) pipelines and the `@lit-labs/signals` primitive — one rendering pipeline, two hosts.
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

| Concern | Package | Rationale |
|---|---|---|
| TUI framework | `ink` 6 + `react` 19 | Claude Code, Codex CLI, Gemini CLI, Wrangler, Astro all on Ink. Yoga flexbox. ESM-native. `<Static>` preserves scrollback. |
| Component kit | `@inkjs/ui` | Official. Spinner, Select, MultiSelect, TextInput, ConfirmInput, Alert, ProgressBar, UnorderedList, Badge. |
| Focus & keys | Ink built-ins (`useInput`, `useFocus`, `useFocusManager`) | No external keybinding library needed. |
| State inside Ink | `@lit-labs/signals` + a `useSignal` bridge (`useSyncExternalStore`) | Same primitive the webview's `progressState` uses. Shared mental model. |
| Bundler | `esbuild` (existing) | Already wired in `packages/cli/scripts/build-bundle.mjs`. |

### Inputs & one-shot prompts

| Concern | Package |
|---|---|
| CLI argument parser | `citty` (UnJS) |
| One-shot prompts outside TUI | `@clack/prompts` |
| Inline TUI input | `ink-text-input` (+ our own autocomplete on `@inkjs/ui` `Select`) |
| Fuzzy match (palette / file `@`) | `fzf-for-js` |
| Workspace file discovery (`@`-mention) | `fast-glob` against the CLI's workspace cwd (no current `WorkspaceProvider.findFiles`; see §17 R8) |
| Input history persistence | File at `path.join(platform().storage.getGlobalStoragePath(), 'history.jsonl')` — `getGlobalStoragePath()` returns the directory (`~/.texra/global-storage` by default), not the file |

### Rendering (shared with webview where possible)

| Concern | Source |
|---|---|
| Markdown | `markdown-it` + `markdown-it-texmath` (reuse webview's `markdownRenderer.ts`, with an ANSI rule plugin added for the CLI host) |
| Syntax highlighting | `cli-highlight` (highlight.js wrapper for ANSI). The workspace's shared highlighter (`src/shared/highlighting/{highlightCode,hljs}.ts`) is already highlight.js-based, so this matches the existing grammar/theme surface. |
| Math `$...$` | `unicodeit` fallback for inline; block math passes through raw in v1 |
| Diffs | `diff` for hunks + `cli-highlight` for line coloring |
| Hyperlinks | `terminal-link` (OSC 8) for clickable paths |
| ANSI-safe truncation / wrap | `string-width` + `wrap-ansi` |

### Plumbing

| Concern | Package |
|---|---|
| Serial follow-up queue | `p-queue` |
| Colors (legacy renderer only) | `picocolors` |
| Clipboard ("copy last response") | `clipboardy` (with OSC 52 fallback) |
| Tests | `ink-testing-library` + existing `vitest` |

### Deliberately omitted

`chalk` (picocolors suffices), `commander` (citty is leaner and ESM-first), `inquirer` (@clack/prompts replaces it), `marked-terminal` (we reuse the markdown-it pipeline), `shiki` (the workspace highlighter is highlight.js-based; switching to shiki is its own migration, out of scope here), `boxen` (Ink `<Box borderStyle>`), `ora` (`@inkjs/ui` Spinner), `ink-tab` (Ink 6 focus mgmt suffices), `zustand` / `jotai` / `xstate` (signals already in workspace).

## 6. Wheels to drop

Each entry is a deletion candidate, not a wrapper.

| Today | Where | Replace with |
|---|---|---|
| `splitGlobalArgs`, `splitRunArgs`, `flagValue`, `cliFlagName`, `hasBooleanFlag`, four `FLAGS_WITH_VALUE` sets | `cliContext.ts:44–166, 224–268` | `citty` `defineCommand` |
| `ANSI_TONES`, tone-switching `write()` | `terminalRenderer.ts:20–27, 546–552` | `picocolors` in legacy; Ink `<Text color>` in TUI |
| `truncateText`, `formatOutputSnippet`, `formatUnknownSnippet` | `terminalRenderer.ts:61–64, 310–367` | `string-width` + `wrap-ansi` |
| `renderedToolUseSignatures` `JSON.stringify` dedup | `terminalRenderer.ts:181–183` | `useSyncExternalStore` + React `memo` keyed on `entry.id + entry.seqNo` |
| `MultilineDraftState` + `/multi` `/send` `/cancel` plumbing | `runChat.ts:63–66, 451–469, 507–511` | `ink-text-input` with `Ctrl-J` newline; `/multi` retained as alias |
| `followUpFlush` promise chain, `pendingFollowUps`, `flushPendingFollowUps`, `streamReadyForFollowUps` | `runChat.ts:58–61, 255–304` | `p-queue` (`concurrency: 1`) |
| `askCliQuestion`, `createCliLineReader` | `logSinks.ts:87–107` | `@clack/prompts` outside TUI; Ink inside |
| `installChatResponsePrinter` log-diff loop | `runChat.ts:109–141` | `useStreamLog(streamId)` hook + `<Static>` for finalized turns |
| ASCII `-- title --` / `| line` cards | `terminalRenderer.ts:513–524` | Ink `<Box borderStyle="round">` |

Net: ~400 LOC deleted across `terminalRenderer.ts`, `runChat.ts`, `cliContext.ts`, `logSinks.ts`; replaced by ~120 LOC of provider + hook glue.

## 7. Architecture

The webview already does this. We're cloning its topology, not inventing.

```
CLI runtime host emit ─┐    (packages/cli/src/runtime/runtimeHost.ts:37–69 — the
                       │     CLI's actual event source; events are routed here
                       │     and do NOT pass through the global ProgressEventBus.
                       │     The TUI wraps host.emit, exactly as today's plain
                       │     renderer does in runChat.ts:378–388.)
StreamLogStore.onChange ─┼─► signals state ─► React components (Ink)
StreamStatusService.onDidChange ┘  (@lit-labs/signals,    │
                                    same primitive as         ├── <Static> for finalized turns
                                    webview's progressState)  └── live <Box> for in-flight turn

Approval payloads (intercepted in host.emit) ──► approvalQueue signal ──► <ApprovalModal>
                                                                          ├─► handleProgressViewBashApprovalAction
                                                                          ├─► setToolEditApprovalHandler resolver
                                                                          ├─► resolvePlanApproval
                                                                          ├─► resolveProposal
                                                                          ├─► triggerRetry / cancelRetry
                                                                          └─► handleExternalInquiryAction
```

One state primitive, two renderers. The webview uses `appState = signal(createInitialState())` (`progressState.ts:66`). The CLI declares an identically-shaped signal in `packages/cli/src/chat/tui/state/cliState.ts`. The signal *primitive* (`@lit-labs/signals`) and the *shape* are shared; the *event sources* differ — the webview subscribes to the global `ProgressEventBus` and to messages from the extension host, while the CLI subscribes to the runtime host wrapper plus `StreamLogStore` and `StreamStatusService` directly.

```
packages/cli/src/chat/tui/
├── App.tsx
├── state/
│   ├── cliState.ts                 (@lit-labs/signals; mirrors progressState shape, activeStreamId: StreamTabId | null)
│   ├── useSignal.ts                (≈10-line useSyncExternalStore bridge)
│   ├── subscribeRuntimeHost.ts     (wraps runtimeHost.emit; routes payloads → signal patches and approvalQueue)
│   ├── subscribeStreamLog.ts       (StreamLogStore.onChange → signal patch)
│   └── subscribeStreamStatus.ts    (StreamStatusService.onDidChange → signal patch)
├── panes/
│   ├── Header.tsx                  (agent, model, usage, status)
│   ├── ConversationPane.tsx        (<Static> + live <Box>)
│   ├── SubagentList.tsx            (updateActiveSubagents / updateActiveProcesses)
│   ├── TodosPlanPanel.tsx
│   ├── StatusBar.tsx               (yolo / bypass / queued-followup badges)
│   └── InputBar.tsx
├── modals/
│   ├── BashApproval.tsx
│   ├── EditApproval.tsx            (diff + cli-highlight)
│   ├── PlanApproval.tsx
│   ├── AgentProposal.tsx
│   ├── RetryRequest.tsx
│   └── ExternalInquiry.tsx
├── render/
│   ├── ToolUseCard.tsx
│   ├── Markdown.tsx                (markdown-it + ANSI rule plugin)
│   ├── CodeBlock.tsx               (highlight.js via @shared/highlighting → cli-highlight render)
│   └── DiffView.tsx
├── commands/
│   ├── slashRegistry.ts            (reads from @agent + @model registries)
│   ├── palette.tsx                 (Ctrl-P, fzf-for-js)
│   └── fileMention.tsx             (@, fast-glob against platform().workspace.getWorkspacePath())
├── streams/
│   ├── streamTabs.ts               (reuses StreamTabId from @shared/schemas/identifiers)
│   └── focusCycle.ts               (Ctrl-A across active descendants)
└── history/
    └── inputHistory.ts             (path.join(platform().storage.getGlobalStoragePath(), 'history.jsonl'))
```

`runChat.ts` shrinks to: parse args (citty), init platform (unchanged), install approval handlers (unchanged), `render(<App/>)`. The multiline state, follow-up queue, log-diff loop, and approval prompting all move into the React tree or external libraries.

## 8. Multi-agent: `StreamTabId` is the only model

`StreamTabId` is already the shared identifier (`src/shared/schemas/identifiers.ts`). The webview's `progressState` keeps `streamById: Map<StreamTabId, StreamTabInfo>` with `activeStreamId: StreamTabId | null` (`progressState.ts:66`, `store.ts:66–79`). The CLI inherits that model unchanged.

- `cliState.streamById: Signal<Map<StreamTabId, StreamTabInfo>>` — populated from `setActiveStream`, `setParentStream`, `removeStream`, `updateStreamStatus`.
- `cliState.activeStreamId: Signal<StreamTabId | null>` — `null` before any stream exists; switched by `Ctrl-A` cycle, palette pick, or auto-follow on `setActiveStream`.
- `<SubagentList>` renders one row per descendant of the root stream, with status / model / elapsed / tokens. Number keys `1`–`9` jump focus. `Ctrl-A` cycles forward. `Ctrl-B` returns to parent. (Avoid `Ctrl-Shift-*`: many terminals collapse Shift modifiers on letter keys to the unshifted Ctrl chord — Ink cannot distinguish them on the smoke-test matrix.)
- Detached children (`detachActiveChildren`, `executionRegistry.ts:253–269`) **require a runtime patch**: today the function calls `handle.detach()` and re-emits `updateActiveSubagents` for the old parent only — it does **not** emit `setParentStream` to clear the child's `parentStreamId`. Phase 4 adds a `setParentStream` emit inside `detachActiveChildren` so the TUI (and any future host that consumes the parent-link) promotes detached children to top-level streams.
- Child stream readiness signal: subscribe to `setActiveStream` and `setParentStream` as the primary readiness events, with any transition into `RUNNING` from `StreamStatusService` as a fallback. Do **not** key off the specific `INITIALIZING → RUNNING` transition; the existing child-stream lifecycle can produce `READY → RUNNING` instead.

## 9. Approvals: typed modal queue replaces stderr prompts

This is a typed-adapter replacement, **not** just swapping the prompt path. `CliContext.approvalPrompt` only carries `CliPromptRequest` (`kind`, `summary`, `prompt`) — that's enough for today's free-text approval but loses the typed payload the TUI needs (the bash command string, the tool-edit `originalContent`/`proposedContent`, the plan structure, the proposal's agent metadata).

- A new TUI-aware approval installer replaces `installCliApprovalHandlers`. It registers:
  - A `setToolEditApprovalHandler` callback that pushes a `ToolEditApprovalRequest` (which already contains `originalContent` + `proposedContent`) onto `cliState.approvalQueue` and awaits a typed reply. (Today's CLI tool-edit path never emits `showToolEditPermission` — it goes through the handler directly. The TUI keeps that route and just changes how the user answers.)
  - For `showBashPermission`, `showPlanApproval`, `showAgentProposal`, `showRetryRequest`, `showExternalInquiry`: a `handleCliApprovalEvent`-style interceptor inside the wrapped `runtimeHost.emit` that pushes the *full typed payload* onto `cliState.approvalQueue`, keyed by event name. `<ApprovalModal>` dispatches to the matching sub-component by the payload's discriminant.
- On resolution, the modal calls the same resolvers today's adapter calls: `handleProgressViewBashApprovalAction`, `resolvePlanApproval`, `resolveProposal`, `triggerRetry` / `cancelRetry`, `handleExternalInquiryAction`. Resolver wiring is unchanged.
- `--approval-policy never` and `--approval-policy yolo` short-circuit before reaching the queue (unchanged `immediateDecision` logic from `approvalAdapter.ts:89–94`).
- `<EditApproval>` renders unified diffs from `originalContent` + `proposedContent` using `diff` + `cli-highlight`. Keys: `y` approve, `n` reject, `e` reject-with-feedback (inline `<TextInput>`).

## 10. Event → component map

Every signal source already exists.

| Event | Consumer | Render |
|---|---|---|
| `updateStreamUsage` | `<Header>` | tokens, cost, elapsed |
| `updateConversationProgress` | `<Header>` | turn / tool counts |
| `updateStreamDescription` | `<Header>` | session subtitle |
| `StreamStatusService.onDidChange` | `<StatusBar>`, `<InputBar>` | status pill, prompt enabled |
| `StreamLogStore` (`MODEL_RESPONSE`) | `<ConversationPane>` | streaming text → `<Static>` on turn end |
| `StreamLogStore` (`TOOL_USE`) | `<ToolUseCard>` | header + status, expandable detail |
| `updateActiveSubagents` | `<SubagentList>` | one row per `ActiveChildInfo`, spinner, focus key |
| `updateActiveProcesses` | `<SubagentList>` (processes section) | one row per process |
| `updateProcessOutput` | child stream view (on focus) | stdout / stderr tail |
| `updateTodos` | `<TodosPlanPanel>` | checklist |
| `updatePlan` | `<TodosPlanPanel>` | numbered steps, status |
| `setActiveStream` | `<App>` router | switch primary streamId |
| `setParentStream` | `<App>` router | nest child under parent |
| `removeStream` | `<App>` router | cleanup |
| `updateQueuedFollowUps` | `<InputBar>` | "queued: N" pill |
| `updateToolEditApprovalBypassState` / `updateSuperYoloBypassState` | `<StatusBar>` | YOLO / BYPASS badge |
| `showBashPermission` | `<BashApproval>` | resolver: `handleProgressViewBashApprovalAction` |
| `showToolEditPermission` | `<EditApproval>` | resolver: `setToolEditApprovalHandler` callback |
| `showPlanApproval` | `<PlanApproval>` | resolver: `resolvePlanApproval` |
| `showAgentProposal` | `<AgentProposal>` | resolver: `resolveProposal` |
| `showRetryRequest` | `<RetryRequest>` | resolver: `triggerRetry` / `cancelRetry` |
| `showExternalInquiry` | `<ExternalInquiry>` | resolver: `handleExternalInquiryAction` |

## 11. Keymap

| Key | Action |
|---|---|
| `Enter` | Send message |
| `Ctrl-J` | Newline (kills `/multi` ceremony) |
| `Tab` | Autocomplete (file, slash, agent, model) |
| `↑` / `↓` | History (input) / row navigation (lists, modals) |
| `Ctrl-R` | Reverse history search |
| `Ctrl-P` | Command palette |
| `Ctrl-A` / `Ctrl-B` | Cycle active child / back to parent (avoiding `Ctrl-Shift-A`, which collapses to `Ctrl-A` on many terminals) |
| `0` | Jump back to root stream |
| `1`–`9` | Jump to subagent row |
| `Ctrl-T` | Tab view (Conversation / Subagents / Todos+Plan / Logs) |
| `Ctrl-L` | Clear screen (scrollback preserved) |
| `Ctrl-C` | Interrupt active session; second tap exits |
| `Ctrl-D` | Exit on empty input |
| `Esc` | Close modal / palette / cancel inline edit |
| `?` | Inline help overlay |
| `y` / `n` / `e` | Approve / reject / reject-with-feedback |
| `@` | File-picker autocomplete |
| `/` | Slash-command palette |

## 12. Rendering parity with the webview

| Concern | Webview | CLI TUI |
|---|---|---|
| Markdown | `markdown-it` + `markdown-it-texmath` w/ LRU cache | Same `markdown-it` instance + thin ANSI rule plugin |
| Code fences | `highlight.js` via `@shared/highlighting` (`highlightCode.ts` → `hljs.ts`) | Same module's tokenizer; `cli-highlight` renders the tokens to ANSI |
| Math | `katex` → HTML | `unicodeit` for inline; block math raw in v1 |
| Diff | Monaco diff editor | `diff` + `cli-highlight` |
| Tool cards | Lit component per messageType | Ink component per messageType |
| Subagent badges | `BackgroundTasksPanel.ts` | `<SubagentList>` (same data, same `setActiveStream` on activate) |
| Follow-up input | `FollowUpInput.ts` textarea | `<InputBar>` with `/` palette + `@` mention |

Two TUI features the webview does **not** have today:

1. Slash-command palette (`/agent`, `/model`, `/help`, `/status`, `/yolo`, plus registered tools).
2. `@`-mention file picker. Implementation note: `WorkspaceProvider` currently exposes only `getWorkspacePath()`, `asRelativePath()`, and `watch()` — no `findFiles`. v1 ships a CLI-local `fast-glob` walk of `getWorkspacePath()` honoring `.gitignore`. A cross-host `WorkspaceProvider.findFiles(glob, options)` port is desirable and tracked in §17 R8 but not blocking.

Pure additions; no contract change. They can later land in the webview behind the same registry.

## 13. Headless & legacy preserved

- `texra run`, `--print/-p`, non-TTY, `CI=true` — Ink never loads. `runChat.ts` already rejects headless chat; that gate stays. `NdjsonStdoutSink` and its drain/backpressure logic remain in `logSinks.ts` for the headless `--output-format ndjson` path — they are not touched by this PRD.
- `--legacy-renderer` flag retains today's plain renderer (also auto-forced on `TERM=dumb` or `NO_COLOR` + narrow `COLUMNS`). The legacy renderer becomes the only consumer of `picocolors` after migration; everything else lives in Ink.
- `--output-format json|ndjson` output byte-identical. Golden test in `packages/cli/scripts/validate-run.mjs`.
- `<App>` uses `<Static>` for finalized turns; no alt-screen by default. **Caveat:** today's `cliMode()` classifies piped stdout as headless, so `texra chat | tee transcript.log` currently fails the chat gate even with the TUI. If transcript piping becomes a requirement, the TTY gate must be relaxed (e.g. allow `stdin.isTTY && !stderr.isTTY?` — out of scope for v1). Users wanting a transcript today run `texra chat --legacy-renderer 2>&1 | tee transcript.log`.

## 14. Migration phases

Every phase is independently mergeable. Each adds an `--tui` flag, default-off, until Phase 6.

**Phase 0 — Foundation (1 d).** Add `react@19`, `ink@6`, `@inkjs/ui`, `citty`, `picocolors`, `string-width`, `wrap-ansi`. Migrate `cliContext.ts` arg parsing to `citty` (no UI change). Drop `ANSI_TONES` for `picocolors` in legacy renderer. Verify headless tests + `validate-run.mjs` pass.

**Phase 1 — Skeleton (2 d).** Render `<App>` with `<Header>` + `<InputBar>` + `<ConversationPane>` (MODEL_RESPONSE only) behind `--tui`. Wire `cliState` signal + `useSignal` bridge. Subscribe to the wrapped `runtimeHost.emit` + `StreamLogStore.onChange` + `StreamStatusService.onDidChange`. Introduce `p-queue`-backed follow-ups. Approvals still on legacy adapter.

**Phase 2 — Tool & approval rendering (3 d).** `<ToolUseCard>`. Replace `installCliApprovalHandlers` with the typed TUI installer per §9. All six approval modals dispatched off the typed queue. `<DiffView>` using `diff` + `cli-highlight`. Resolver wiring unchanged.

**Phase 3 — Markdown + code (1–2 d).** Lift the webview's `markdownRenderer.ts` into a shared `@shared/markdown` module (it's pure rendering, fits there). Add an ANSI rule plugin for the CLI host that delegates code fences to `cli-highlight`, reusing the grammars the existing `@shared/highlighting/hljs.ts` already pulls from `highlight.js/lib/core`. Wire `<Markdown>` and `<CodeBlock>` into `ConversationPane`. Lazy-load language packs.

**Phase 4 — Multi-agent + tabs (2 d).** `<SubagentList>`, `<TodosPlanPanel>`, `<StatusBar>`. `Ctrl-A` / `Ctrl-B` focus cycle. Stream switching via `setActiveStream`. Process output tailing. Small runtime patch: have `detachActiveChildren` (`executionRegistry.ts:253–269`) emit `setParentStream` so detached children promote to top-level streams.

**Phase 5 — Ergonomics (2 d).** `Ctrl-P` palette (`fzf-for-js`), `Ctrl-R` reverse history, `@` file picker (`fast-glob` against the workspace cwd), `/` command palette, autocomplete on `/agent` & `/model`. Input history at `path.join(platform().storage.getGlobalStoragePath(), 'history.jsonl')`.

**Phase 6 — Stabilise & flip (1 d).** `--tui` defaults on for TTY; `--legacy-renderer` becomes opt-out. README rewrite. Decide `private: true` flip (separate). Smoke matrix: Windows Terminal, iTerm2, macOS Terminal, GNOME Terminal, tmux, screen.

Total: ~11 dev-days, six PRs.

## 15. Testing

- **Unit.** `ink-testing-library` renders each pane / modal against synthetic runtime-host emit + `StreamLogStore` mocks. Snapshot the frame string.
- **Integration.** Extend `packages/cli/scripts/validate-run.mjs` with an interactive variant driving stdin via a PTY harness (`node-pty`, listed as a new dev dependency — note its native build step; if that proves problematic on CI we fall back to writing to `process.stdin` directly with `process.stdout` captured) and asserting frame snapshots.
- **Approval flows.** Per-modal test that the right resolver is called with the right payload. Highest-risk wires.
- **Headless regression.** Existing `texra run` golden outputs unchanged. `--legacy-renderer` keeps the existing plain-mode tests green.

## 16. Risks

- **R1.** `markdown-it` runs in browser today; CLI use requires confirming no DOM dependencies in the existing renderer. *Mitigation:* spike during Phase 3; fall back to `marked` + custom rule set if needed.
- **R2.** `cli-highlight` / `highlight.js` grammar-load cost on first fence (~10 ms per language). *Mitigation:* lazy-load on first code fence; cache loaded languages globally. The workspace already includes the grammars via `@shared/highlighting/hljs.ts`.
- **R3.** Lifting webview-side `markdownRenderer.ts` upward violates `packages/extension` → CLI direction. *Mitigation:* move the module into `src/shared/` since it's pure rendering with no VS Code coupling.
- **R4.** Ink `<Static>` + `<Box>` interaction in tmux / screen. Established as workable by Claude Code; verify in smoke matrix.
- **R5.** Bundle size: react 19 + ink 6 + highlight.js languages ≈ 600–900 KB. Acceptable for a CLI; flag at review.
- **R6.** Windows TTY edge cases (Ctrl-J = LF on some terminals, non-VT100 sequences). *Mitigation:* test on Windows Terminal + ConHost; rely on Ink's key normalization.
- **R7.** Resource path resolution (`resolveResourcesPath` in `cliContext.ts:290–299`) changes once the package is published rather than linked. Tracked separately; not Ink-specific.
- **R8.** No `WorkspaceProvider.findFiles` exists today. `@`-mention v1 uses `fast-glob` against `getWorkspacePath()` from CLI code. Cross-host parity (VS Code-aware `findFiles`) is a separate platform-layer change; not blocking, but tracked.

## 17. Success criteria

- Every event in §10 renders in the TUI with visible parity to the VS Code Progress View on the same agent run.
- A user completes a 3-subagent run, approves two edits, and rejects one bash command without typing a single slash command.
- `texra run --output-format ndjson` output byte-identical before/after.
- `texra chat --legacy-renderer` byte-identical to today.
- New runtime deps: `react`, `ink`, `@inkjs/ui`, `ink-text-input`, `citty`, `@clack/prompts`, `picocolors`, `string-width`, `wrap-ansi`, `p-queue`, `diff`, `cli-highlight`, `fast-glob`, `fzf-for-js`, `terminal-link`, `clipboardy`, `unicodeit`.
- New dev deps: `ink-testing-library`, `node-pty` (PTY-driven integration tests).
- Existing `markdown-it` + `markdown-it-texmath` lifted from `packages/extension/src/progressView/frontend/formatters/` into `src/shared/markdown/`. Existing `@shared/highlighting` (highlight.js) consumed as-is.

## 18. References

**CLI surfaces (current):** `packages/cli/src/runtime/cliContext.ts:44–268` · `packages/cli/src/chat/terminalRenderer.ts:20–367, 513–524` · `packages/cli/src/chat/runChat.ts:58–66, 109–141, 255–304, 451–511` · `packages/cli/src/runtime/logSinks.ts:87–196` · `packages/cli/src/runtime/approvalAdapter.ts:89–94, 268–270`.

**Webview reference topology:** `packages/extension/src/progressView/frontend/progressState.ts:66` (appState declaration) · `packages/extension/src/progressView/frontend/store.ts:66–79` · `packages/extension/src/progressView/frontend/formatters/markdownRenderer.ts:6–53` · `packages/extension/src/progressView/frontend/components/{BackgroundTasksPanel,TexraDiffView,FollowUpInput,ToolEditRequestPanel,BashRequestPanel,ProposalRequestPanel,PlanApprovalRequestPanel,ExternalInquiryPanel}.ts`.

**Shared infrastructure:** `src/shared/schemas/identifiers.ts` (`StreamTabIdSchema`) · `src/shared/highlighting/{highlightCode.ts, hljs.ts}` (highlight.js wrapper) · `src/agent/runtime/{StreamStatusService.ts:33–72, ExecutionHandle.ts:104–106, executionRegistry.ts:32–205, 253–269}` · `src/eventBus/ProgressEventBus.ts:60–227` · `src/logger/{StreamLogStore.ts:95–114, AgentLogger.ts:130–587, structuredLogger.ts}` · `src/platform/interfaces/{workspace.ts, storage.ts}` · `src/platform/platform.ts` + `defaults/` · `docs/pocketflow/`.
