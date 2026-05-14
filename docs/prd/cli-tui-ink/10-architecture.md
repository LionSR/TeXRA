# 10 · Architecture

## 5. Tech stack (locked)

Every dependency is either already in the workspace, used by the dominant 2026 AI CLIs, or replaces an existing hand-rolled utility. Three items carry open spikes — see [30-reference.md § Risks](./30-reference.md#risks) R1 (markdown-it DOM coupling), R7 (resource path post-publish), and R12 (React Compiler build).

### Runtime & framework

| Concern           | Package                                                             | Rationale                                                                                                                                |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| TUI framework     | `ink` 6 + `react` 19                                                | Claude Code, Codex CLI, Gemini CLI, Wrangler, Astro all on Ink. Yoga flexbox. ESM-native. `<Static>` preserves scrollback.               |
| Component kit     | `@inkjs/ui`                                                         | Official. Spinner, Select, MultiSelect, TextInput, ConfirmInput, Alert, ProgressBar, UnorderedList, Badge.                               |
| Focus & keys      | Ink built-ins (`useInput`, `useFocus`, `useFocusManager`)           | No external keybinding library needed.                                                                                                   |
| State inside Ink  | `@lit-labs/signals` + a `useSignal` bridge (`useSyncExternalStore`) | Same primitive the webview's `progressState` uses. Shared mental model.                                                                  |
| Build memoization | `babel-plugin-react-compiler` (React 19 Compiler)                   | Auto-memoizes JSX subtrees and dependency tuples. Zero-API-change perf win; load-bearing for high-frequency streaming updates. Risk R12. |
| Bundler           | `esbuild` (existing) + Babel pre-pass for the React Compiler        | esbuild already wired in `packages/cli/scripts/build-bundle.mjs`. Compiler runs as a single Babel transform over `.tsx`.                 |

### Inputs & one-shot prompts

| Concern                                | Package                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI argument parser                    | `citty` (UnJS)                                                                                                                                                                        |
| One-shot prompts outside TUI           | `@clack/prompts`                                                                                                                                                                      |
| Inline TUI input                       | `ink-text-input` wrapped by an in-tree `BaseTextInput` component (viewport tracking + declared-cursor + paste-aware Enter handling — see § Input component)                           |
| Bracketed paste detection              | Ink raw-stdin path parses `CSI 200 ~` / `CSI 201 ~`; an `isPasted` flag is propagated to consumers via `usePasteHandler` (see § Input component)                                      |
| Fuzzy match (palette / file `@`)       | `fzf-for-js`                                                                                                                                                                          |
| Workspace file discovery (`@`-mention) | `fast-glob` against the CLI's workspace cwd (no current `WorkspaceProvider.findFiles`; see R8)                                                                                        |
| Input history persistence              | File at `path.join(platform().storage.getGlobalStoragePath(), 'history.jsonl')` — `getGlobalStoragePath()` returns the directory (`~/.texra/global-storage` by default), not the file |

### Rendering (shared with webview where possible)

| Concern                      | Source                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown                     | `markdown-it` + `markdown-it-texmath` (reuse webview's `markdownRenderer.ts`, with an ANSI rule plugin added for the CLI host)                                                                                                                                                                                                                    |
| **Markdown token LRU cache** | The webview's `markdownRenderer.ts` already memoizes lexer output by content hash. **This cache MUST be preserved** when the module is lifted into `src/shared/markdown/` — streamed responses re-render on every chunk, and re-lexing the full buffer per chunk is the dominant cost. Cap 500 entries (matches Claude Code's `TOKEN_CACHE_MAX`). |
| Syntax highlighting          | `cli-highlight` (highlight.js wrapper for ANSI). The workspace's shared highlighter (`src/shared/highlighting/{highlightCode,hljs}.ts`) is already highlight.js-based, so this matches the existing grammar/theme surface.                                                                                                                        |
| Math `$...$`                 | `unicodeit` fallback for inline; block math passes through raw in v1                                                                                                                                                                                                                                                                              |
| Diffs                        | `diff` for hunks + `cli-highlight` for line coloring                                                                                                                                                                                                                                                                                              |
| Hyperlinks                   | `terminal-link` (OSC 8) for clickable paths                                                                                                                                                                                                                                                                                                       |
| ANSI-safe truncation / wrap  | `string-width` + `wrap-ansi`                                                                                                                                                                                                                                                                                                                      |

### Terminal capability discovery

| Concern                     | Approach                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime feature negotiation | At startup, write a batch of terminal queries (Kitty keyboard `CSI ? u`, DECRQM 2027 grapheme support, OSC color reads, bracketed-paste DECRQM) followed by a **DA1 sentinel** (`CSI c`). DA1 is universally answered. Read responses from stdin; any feature whose reply arrives before DA1 is supported, anything that doesn't is not. No timeouts, no false negatives. Implemented in `tui/state/terminalCapabilities.ts`. Pattern adapted from Claude Code `src/ink/terminal-querier.ts`. |

### Plumbing

| Concern                          | Package                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Serial follow-up queue           | `p-queue`                                                                       |
| Approval modal queue             | `p-queue` (`concurrency: 1`) with Promise-returning launchers — see § Approvals |
| Colors (legacy renderer only)    | `picocolors`                                                                    |
| Clipboard ("copy last response") | `clipboardy` (with OSC 52 fallback; tmux/screen DCS wrapping deferred — R9)     |
| Tests                            | `ink-testing-library` + existing `vitest`                                       |

### Deliberately omitted

`chalk` (picocolors suffices), `commander` (citty is leaner and ESM-first), `inquirer` (@clack/prompts replaces it), `marked-terminal` (we reuse the markdown-it pipeline), `shiki` (the workspace highlighter is highlight.js-based; switching to shiki is its own migration, out of scope here), `boxen` (Ink `<Box borderStyle>`), `ora` (`@inkjs/ui` Spinner), `ink-tab` (Ink 6 focus mgmt suffices), `zustand` / `jotai` / `xstate` (signals already in workspace).

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

Approval payloads (intercepted in host.emit) ──► approvalQueue (p-queue, concurrency: 1)
                                                       └──► launcher returns Promise<Decision>
                                                            <ApprovalModal> renders + resolves
                                                            ├─► handleProgressViewBashApprovalAction
                                                            ├─► setToolEditApprovalHandler resolver
                                                            ├─► resolvePlanApproval
                                                            ├─► resolveProposal
                                                            ├─► triggerRetry / cancelRetry
                                                            └─► handleExternalInquiryAction
```

One state primitive, two renderers. The webview uses `appState = signal(createInitialState())` (`progressState.ts:66`). The CLI declares an identically-shaped signal in `packages/cli/src/chat/tui/state/cliState.ts`. The signal _primitive_ (`@lit-labs/signals`) and the _shape_ are shared; the _event sources_ differ — the webview subscribes to the global `ProgressEventBus` and to messages from the extension host, while the CLI subscribes to the runtime host wrapper plus `StreamLogStore` and `StreamStatusService` directly.

```
packages/cli/src/chat/tui/
├── App.tsx
├── state/
│   ├── cliState.ts                 (@lit-labs/signals; mirrors progressState shape, activeStreamId: StreamTabId | null)
│   ├── useSignal.ts                (≈10-line useSyncExternalStore bridge)
│   ├── subscribeRuntimeHost.ts     (wraps runtimeHost.emit; routes payloads → signal patches and approvalQueue)
│   ├── subscribeStreamLog.ts       (StreamLogStore.onChange → signal patch)
│   ├── subscribeStreamStatus.ts    (StreamStatusService.onDidChange → signal patch)
│   └── terminalCapabilities.ts     (DA1-sentinel feature discovery; populates signal at startup)
├── panes/
│   ├── Header.tsx                  (agent, model, usage, status)
│   ├── ConversationPane.tsx        (<Static> + live <Box>)
│   ├── SubagentList.tsx            (updateActiveSubagents / updateActiveProcesses)
│   ├── TodosPlanPanel.tsx
│   ├── StatusBar.tsx               (yolo / bypass / queued-followup badges)
│   └── InputBar.tsx                (uses BaseTextInput)
├── modals/
│   ├── BashApproval.tsx
│   ├── EditApproval.tsx            (diff + cli-highlight)
│   ├── PlanApproval.tsx
│   ├── AgentProposal.tsx
│   ├── RetryRequest.tsx
│   └── ExternalInquiry.tsx
├── input/
│   ├── BaseTextInput.tsx           (wraps ink-text-input: viewport, declared-cursor, paste-aware submit)
│   └── usePasteHandler.tsx         (consumes ParsedKey.isPasted; suppresses auto-submit during paste)
├── render/
│   ├── ToolUseCard.tsx
│   ├── Markdown.tsx                (markdown-it + ANSI rule plugin; consumes the shared LRU token cache)
│   ├── CodeBlock.tsx               (highlight.js via @shared/highlighting → cli-highlight render)
│   ├── DiffView.tsx
│   └── frameTelemetry.ts           (subscribes to ink onFrame; emits per-phase timings + flicker context to logger)
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

### Input component

`BaseTextInput` wraps `ink-text-input` and adds three behaviors `ink-text-input` does not provide:

1. **Paste-aware submit.** A `usePasteHandler` hook reads `ParsedKey.isPasted` from the keypress event. While a paste is in progress (between `CSI 200 ~` and `CSI 201 ~`), Enter is treated as a newline rather than submit. Without this, pasting an N-line LaTeX block fires N submissions and N approval modals — a routine workflow for academic users.
2. **Viewport tracking** (`viewportCharOffset`, `viewportCharEnd`). When the input value exceeds the visible width, the input slides horizontally rather than soft-wrapping. The viewport state is exposed so that overlays (autocomplete, file mentions) can position themselves over the visible region.
3. **Declared cursor.** The component reports its cursor position to the renderer via context, so the renderer can drive the terminal cursor (rather than ink's internal carat) — necessary for IME and screen-reader cooperation.

This pattern is lifted directly from Claude Code (`src/components/BaseTextInput.tsx`, `src/hooks/usePasteHandler.tsx`).

### Frame telemetry

`render/frameTelemetry.ts` subscribes to ink's `onFrame` hook (Ink 6 exposes per-frame events) and records:

- per-phase wall time: render / diff / write / yoga-layout;
- yoga-measured nodes count;
- flicker triggers with debug context (`triggerY`, `prevLine`, `nextLine`).

Output is funneled to the standard logger at `trace` level; CI can grep for flicker triggers in regression matrix runs. This is **not** a perf system, it's an observability hook — multi-agent + streaming markdown + 100-turn conversations have many small re-renders, and post-launch jank reports are unactionable without per-phase timing.

## 8. Multi-agent specifics

The state shape (`streamById: Map<StreamTabId, StreamTabInfo>` + `activeStreamId: StreamTabId | null`) is inherited from the webview (`progressState.ts:66`, `store.ts:66–79`) per [Non-goals](./00-overview.md#4-non-goals-explicitly-excluded) and § Architecture. Three CLI-specific points:

- **Readiness signal.** Subscribe to `setActiveStream` and `setParentStream` as primary readiness events; fall back to any transition into `RUNNING` from `StreamStatusService`. Do **not** key off `INITIALIZING → RUNNING` specifically — the existing child-stream lifecycle can produce `READY → RUNNING` instead.
- **Detach runtime patch.** `detachActiveChildren` (`executionRegistry.ts:253–269`) today calls `handle.detach()` and re-emits `updateActiveSubagents` only — it does **not** emit `setParentStream` to clear the child's `parentStreamId`. Phase 4 adds that emit so the TUI (and any future host that consumes the parent-link) promotes detached children to top-level streams.
- **Why not `Ctrl-Shift-*`.** Many terminals collapse Shift on a letter to the unshifted Ctrl chord; Ink cannot distinguish them on the smoke-test matrix. Hence `Ctrl-A` cycles forward and `Ctrl-B` returns to parent (see [30-reference.md § Keymap](./30-reference.md#keymap)).

## 9. Approvals: Promise-returning launchers with a concurrency-1 queue

This replaces stderr prompts with a typed React dispatch. The implementation pattern is **Promise-returning launchers backed by a serial queue**, not a hand-rolled FIFO state machine.

`CliContext.approvalPrompt` only carries `CliPromptRequest` (`kind`, `summary`, `prompt`) — that's enough for today's free-text approval but loses the typed payload the TUI needs (the bash command string, the tool-edit `originalContent`/`proposedContent`, the plan structure, the proposal's agent metadata).

### Mechanism

- A new TUI-aware approval installer replaces `installCliApprovalHandlers`. It exposes one entrypoint per approval kind, each of which:
  1. constructs the typed payload from the runtime-host event;
  2. enqueues it on a `p-queue` instance with `concurrency: 1` (the approval queue);
  3. returns a `Promise<Decision>` that resolves when the user answers.
- Inside the queue, the head item is pushed onto the `cliState.approvalQueue` signal. `<ApprovalModal>` reads the signal, dispatches by the payload's discriminant, and calls `resolve(decision)` on action. The queue then advances to the next item.

This gives the simplicity of `await launchBashApproval(payload)` at the call site **without** losing the ability to serialize concurrent approvals from different subagent streams — which the original FIFO queue was designed to handle.

### Wiring per event

- `setToolEditApprovalHandler` is registered as before — today's CLI tool-edit path never emits `showToolEditPermission`, so the typed `ToolEditApprovalRequest` (with `originalContent` + `proposedContent`) is pushed directly from the handler. The TUI keeps that route and only changes how the user answers.
- For `showBashPermission`, `showPlanApproval`, `showAgentProposal`, `showRetryRequest`, `showExternalInquiry`: a `handleCliApprovalEvent`-style interceptor inside the wrapped `runtimeHost.emit` constructs the payload and calls the matching `launchX(payload)` entrypoint.
- On resolution, the modal calls the same resolvers today's adapter calls: `handleProgressViewBashApprovalAction`, `resolvePlanApproval`, `resolveProposal`, `triggerRetry` / `cancelRetry`, `handleExternalInquiryAction`. Resolver wiring is unchanged.
- `--approval-policy never` and `--approval-policy yolo` short-circuit before reaching the queue (unchanged `immediateDecision` logic from `approvalAdapter.ts:89–94`).
- `<EditApproval>` renders unified diffs from `originalContent` + `proposedContent` using `diff` + `cli-highlight`. Keys: `y` approve, `n` reject, `e` reject-with-feedback (inline `<TextInput>`).

### Audit prerequisite

Before merging the Promise launcher refactor, audit whether two streams (e.g. the main stream and a running subagent) can emit approval requests within the same tick. If they can — likely, given §8 — the queue is load-bearing; if they cannot, the queue degenerates into a simple `await` chain but no code changes. Either way the API surface (`launchX → Promise<Decision>`) is identical.

## 10. Event → component map

Every signal source already exists.

| Event                                                              | Consumer                             | Render                                            |
| ------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------- |
| `updateStreamUsage`                                                | `<Header>`                           | tokens, cost, elapsed                             |
| `updateConversationProgress`                                       | `<Header>`                           | turn / tool counts                                |
| `updateStreamDescription`                                          | `<Header>`                           | session subtitle                                  |
| `StreamStatusService.onDidChange`                                  | `<StatusBar>`, `<InputBar>`          | status pill, prompt enabled                       |
| `StreamLogStore` (`MODEL_RESPONSE`)                                | `<ConversationPane>`                 | streaming text → `<Static>` on turn end           |
| `StreamLogStore` (`TOOL_USE`)                                      | `<ToolUseCard>`                      | header + status, expandable detail                |
| `updateActiveSubagents`                                            | `<SubagentList>`                     | one row per `ActiveChildInfo`, spinner, focus key |
| `updateActiveProcesses`                                            | `<SubagentList>` (processes section) | one row per process                               |
| `updateProcessOutput`                                              | child stream view (on focus)         | stdout / stderr tail                              |
| `updateTodos`                                                      | `<TodosPlanPanel>`                   | checklist                                         |
| `updatePlan`                                                       | `<TodosPlanPanel>`                   | numbered steps, status                            |
| `setActiveStream`                                                  | `<App>` router                       | switch primary streamId                           |
| `setParentStream`                                                  | `<App>` router                       | nest child under parent                           |
| `removeStream`                                                     | `<App>` router                       | cleanup                                           |
| `updateQueuedFollowUps`                                            | `<InputBar>`                         | "queued: N" pill                                  |
| `updateToolEditApprovalBypassState` / `updateSuperYoloBypassState` | `<StatusBar>`                        | YOLO / BYPASS badge                               |
| `showBashPermission`                                               | `<BashApproval>`                     | resolver: `handleProgressViewBashApprovalAction`  |
| `showToolEditPermission`                                           | `<EditApproval>`                     | resolver: `setToolEditApprovalHandler` callback   |
| `showPlanApproval`                                                 | `<PlanApproval>`                     | resolver: `resolvePlanApproval`                   |
| `showAgentProposal`                                                | `<AgentProposal>`                    | resolver: `resolveProposal`                       |
| `showRetryRequest`                                                 | `<RetryRequest>`                     | resolver: `triggerRetry` / `cancelRetry`          |
| `showExternalInquiry`                                              | `<ExternalInquiry>`                  | resolver: `handleExternalInquiryAction`           |
