---
created: 2026-05-14
updated: 2026-06-13
---

# 10 · Architecture

## 5. Tech stack (locked)

Every dependency is either already in the workspace, used by the dominant 2026 AI CLIs, or replaces an existing hand-rolled utility. Three items carry open spikes — see [2026-05-14-30-reference.md § Risks](./2026-05-14-30-reference.md#16-risks) R1 (markdown-it DOM coupling), R7 (resource path post-publish), and R12 (React Compiler build).

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

| Concern                                | Package                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI argument parser                    | `citty` (UnJS)                                                                                                                                                                                                                                                                                                                                 |
| One-shot prompts outside TUI           | `@clack/prompts`                                                                                                                                                                                                                                                                                                                               |
| Inline TUI input                       | `ink-text-input` wrapped by an in-tree `BaseTextInput` component (viewport tracking + declared-cursor + paste-aware Enter handling — see § Input component)                                                                                                                                                                                    |
| Bracketed paste detection              | Ink raw-stdin path parses `CSI 200 ~` / `CSI 201 ~`; an `isPasted` flag is propagated to consumers via `usePasteHandler` (see § Input component)                                                                                                                                                                                               |
| Fuzzy match (palette / file `@`)       | `fzf-for-js`                                                                                                                                                                                                                                                                                                                                   |
| Workspace file discovery (`@`-mention) | `fast-glob` against the CLI's workspace cwd (no current `WorkspaceProvider.findFiles`; see R8)                                                                                                                                                                                                                                                 |
| Input history persistence              | File at `path.join(platform().storage.getGlobalStoragePath(), 'history.jsonl')` (`getGlobalStoragePath()` returns the directory `~/.texra/global-storage`, not the file). Capped at 5,000 lines via a write-time ring-buffer: append, then if the file exceeds the cap, rewrite with the last 5,000 lines. No background pruning, no rotation. |

### Rendering (shared with webview where possible)

| Concern                     | Source                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown                    | `markdown-it` + `markdown-it-texmath` (reuse webview's `markdownRenderer.ts`, with an ANSI rule plugin added for the CLI host)                                                                                                                                                                                                                  |
| **Markdown render cache**   | The webview's existing cache is keyed `content hash → rendered HTML` (cap 2000 entries + per-entry and total-char budgets) and is therefore host-specific. The CLI host needs a parallel cache keyed `content → ANSI`. A future refactor could pull the cache down to the token level so both hosts share it, but that's a rewrite, not a lift. |
| Syntax highlighting         | `cli-highlight` (highlight.js wrapper for ANSI). The workspace's shared highlighter (`src/shared/highlighting/{highlightCode,hljs}.ts`) is already highlight.js-based, so this matches the existing grammar/theme surface.                                                                                                                      |
| Math `$...$`                | `unicodeit` fallback for inline; block math passes through raw in v1                                                                                                                                                                                                                                                                            |
| Diffs                       | `diff` for hunks + `cli-highlight` for line coloring                                                                                                                                                                                                                                                                                            |
| Hyperlinks                  | `terminal-link` (OSC 8) for clickable paths                                                                                                                                                                                                                                                                                                     |
| ANSI-safe truncation / wrap | `string-width` + `wrap-ansi`                                                                                                                                                                                                                                                                                                                    |

### Terminal capability discovery

| Concern                     | Approach                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime feature negotiation | At startup, write a batch of terminal queries (Kitty keyboard `CSI ? u`, DECRQM 2027 grapheme support, OSC color reads, bracketed-paste DECRQM) followed by a **DA1 sentinel** (`CSI c`). DA1 is universally answered. Read responses from stdin; any feature whose reply arrives before DA1 is supported, anything that doesn't is not. No timeouts, no false negatives. Implemented in `tui/state/terminalCapabilities.ts`. Pattern adapted from Claude Code `src/ink/terminal-querier.ts`. |

### Plumbing

| Concern                          | Package                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Serial follow-up queue           | `p-queue`                                                                                                                    |
| Approval modal queue             | In-tree single-owner FIFO with Promise-returning launchers — see § Approvals                                                 |
| Colors (legacy renderer only)    | `picocolors`                                                                                                                 |
| Clipboard ("copy last response") | `clipboardy` (with OSC 52 fallback; tmux/screen DCS wrapping deferred — R9)                                                  |
| Terminal notifications           | In-tree dispatcher emitting OSC 9 / OSC 99 / BEL (and OSC 9;4 for progress), capability-gated. See § Terminal notifications. |
| Tests                            | `ink-testing-library` + existing `vitest`                                                                                    |

### Deliberately omitted

`chalk` (picocolors suffices), `commander` (citty is leaner and ESM-first), `inquirer` (@clack/prompts replaces it), `marked-terminal` (we reuse the markdown-it pipeline), `shiki` (the workspace highlighter is highlight.js-based; switching to shiki is its own migration, out of scope here), `boxen` (Ink `<Box borderStyle>`), `ora` (`@inkjs/ui` Spinner), `ink-tab` (Ink 6 focus mgmt suffices), `zustand` / `jotai` / `xstate` (signals already in workspace).

## 7. Architecture

Cloning the webview's topology, not inventing one.

```
CLI runtime host emit ─┐    (runtimeHost.ts wraps the actual event source;
                       │     events do NOT pass through ProgressEventBus)
StreamLogStore.onChange ─┼─► signals state ─► React components (Ink)
StreamStatusService.onDidChange ┘  (@lit-labs/signals, same           │
                                    primitive as progressState)            ├── <Static> for finalized turns
                                                                            └── live <Box> for in-flight turn

HostInteractions requests ──► createTuiHostInteractions ──► approvalQueue (single-owner FIFO)
                                                                    └──► launcher returns Promise<Decision>
                                                                         head → currentApproval signal
                                                                         <ApprovalModal> dispatches by payload kind
```

Same signal primitive (`@lit-labs/signals`) and same state shape as the webview's `progressState`; event sources differ — CLI subscribes to `runtimeHost`, `StreamLogStore`, `StreamStatusService` directly.

```
packages/cli/src/chat/tui/
├── App.tsx
├── state/
│   ├── cliState.ts                 (@lit-labs/signals; mirrors progressState shape, activeStreamId: StreamTabId | null)
│   ├── approvalQueue.ts            (single-owner approval/request FIFO; projects head and status signals)
│   ├── subscribeApprovals.ts       (implements the TUI HostInteractions port and routes requests into the FIFO)
│   ├── useSignal.ts                (≈10-line useSyncExternalStore bridge)
│   ├── subscribeRuntimeHost.ts     (wraps runtimeHost.emit; routes runtime events → signal patches)
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
│   ├── ToolUseCard.tsx             (common chrome; dispatches body by tool name; fallback compact body)
│   ├── tools/
│   │   ├── BashCard.tsx            (live-tail body + exit code + truncation banner)
│   │   └── EditCard.tsx            (embedded unified diff; shares DiffView with <EditApproval>)
│   ├── Markdown.tsx                (markdown-it + ANSI rule plugin)
│   ├── CodeBlock.tsx               (highlight.js via @shared/highlighting → cli-highlight render)
│   ├── DiffView.tsx
│   └── frameTelemetry.ts           (subscribes to ink onFrame; emits per-phase timings + flicker context to logger)
├── commands/
│   ├── slashRegistry.ts            (reads from @agent + @model registries; supports inline + form commands)
│   ├── palette.tsx                 (Ctrl-P; sections: slash · agents · models · attachments · files)
│   ├── fileMention.tsx             (@, fast-glob against platform().workspace.getWorkspacePath())
│   ├── transcriptSearch.tsx        (Ctrl-F; substring + fuzzy fallback; SGR 7 inverse overlay — see § Transcript search)
│   └── forms/
│       └── ModelForm.tsx           (structured /model form — see mockups/2026-05-15-09-slash-form.md)
├── attachments/
│   ├── attachmentStore.ts          (cliState.attachments: Map<id, AttachmentRef>; auto-numbering)
│   └── pasteIntercept.ts           (BaseTextInput hook: image bytes → attachment, insert [Image #N] token)
├── ui/
│   └── KeyHints.tsx                (shared footer strip; <KeyboardShortcutHint> + <Byline> per § Intuitiveness conventions)
├── notifications/
│   └── terminalNotifier.ts         (OSC 9 / OSC 99 / BEL / OSC 9;4 progress; capability-gated by terminalCapabilities signal)
├── streams/
│   ├── streamTabs.ts               (reuses StreamTabId from @shared/schemas/identifiers)
│   └── focusCycle.ts               (Ctrl-A across active descendants)
└── history/
    └── inputHistory.ts             (path.join(platform().storage.getGlobalStoragePath(), 'history.jsonl'))
```

`runChat.ts` shrinks to: parse args (citty), init platform (unchanged), install approval handlers (unchanged), `render(<App/>)`. The multiline state, follow-up queue, log-diff loop, and approval prompting all move into the React tree or external libraries.

### Input component

`BaseTextInput` wraps `ink-text-input` with:

1. **Paste-aware submit** via `usePasteHandler` reading `ParsedKey.isPasted`. Enter is treated as newline between `CSI 200 ~` and `CSI 201 ~`, so pasting an N-line block fires one submission.
2. **Horizontal viewport sliding** when the value exceeds visible width; the viewport offsets are exposed for overlay positioning.
3. **Declared cursor** — the input reports cursor position upward so the renderer drives the terminal cursor (necessary for IME).

### Terminal notifications

A `notify({ kind, title?, body })` entrypoint emits notifications for `agentFinished` and `approvalNeeded` (Phase 1) and long-running `progress` (Phase 4). Each emission is capability-gated by the `terminalCapabilities` signal and routed through the multiplexer-aware OSC wrapper (R9). Gated on idle + unfocused-pane signals so it doesn't buzz on every token.

### Transcript search

`Ctrl-F` opens an in-conversation search overlay. Tries exact substring (case-insensitive) first, falls back to fuzzy subsequence via `fzf-for-js`. Match highlighting must be correct on CJK / emoji / overlapping matches.

### Frame telemetry

Per-phase frame timings (render / diff / write / yoga-layout) and flicker context are emitted to the logger at `trace` level for post-launch jank investigation.

### Entrypoint default

`texra` invoked with no subcommand defaults to the interactive launcher
(`texra orchestrate`) when stdin / stdout are TTYs; otherwise it falls through
to `--help`. The launcher lets users pick a chat, resume a session, or run a
team preset. Named subcommands (`texra chat`, `texra run`, `texra setup`,
etc.) keep their explicit names. Wired through citty's default-subcommand
mechanism, no shim.

**Default agent + model resolution.** When `texra` starts the TUI without `--agent` / `--model` overrides, the agent and model are resolved in this order:

1. **Workspace setting** — `.texra/config.json` at the workspace root, if present (`agent`, `model` fields). New convention; no consumer of this path exists in the tree today.
2. **User setting** — `<global-storage>/config.json` (same fields). Also new; today's user-scope settings live in `vscode.workspace.getConfiguration` and won't be there. The CLI host needs a new JSON config loader (`platform().config` currently wraps VS Code's `getConfiguration`).
3. **Last-used** — the agent + model from the most recent `HistoryItem` for this workspace, read from the existing history store.
4. **Built-in default** — `agent: chat`, `model: deepseekT`. The `chat` agent ships in `packages/extension/resources/tool_use_agents/`. There's no schema-level `defaultAgent` / `defaultModel` flag in the agent YAML today; this is a hardcoded fallback in the CLI host.

`/agent` and `/model` slash forms write back to the user setting unless invoked with a `--workspace` modifier (future). The current selection is always visible in the header (per [mockups/2026-05-14-00-idle.md](./mockups/2026-05-14-00-idle.md)).

**Cross-host path unification (out of scope for v1, flagged for a follow-up PRD).** Today the three hosts use different storage roots:

- **CLI** — `~/.texra/global-storage/` (via `nodeStorage.ts`).
- **VS Code extension** — VS Code's `globalStorageUri` (sandboxed under `~/Library/Application Support/Code/User/globalStorage/` on macOS).
- **Desktop (Electron)** — Electron's `app.getPath('userData')` → `~/Library/Application Support/TeXRA/` on macOS (`packages/desktop/src/main/platform/index.ts`).

A user with all three hosts has three separate `history.jsonl`s, three separate config files, three separate session histories. The right end state is a single canonical path (the flat-home-directory pattern — like Codex's `~/.codex/`, the CLI's `~/.texra/`) consumed by all three hosts. That's a platform-layer change, not a TUI change; tracked separately.

### Slash command forms

Slash commands come in two shapes:

1. **Inline actions** — the default. The handler runs to completion without rendering UI (e.g., `/clear`, `/help`, `/agent <name>`). Registered with `{ name, description, handler }`.
2. **Structured forms** — for commands where the user needs to _see_ options before committing (e.g., `/model`, future `/agent` with picker UI). The registry entry declares a `formComponent` (lazy-imported); when invoked, the TUI mounts the component inline, replacing the palette dropdown. The form receives `onDone(result)` and renders title + numbered options (`Select`) + optional sub-state controls + a mandatory `<KeyHints>` footer.

Pattern lifted from Claude Code's `local-jsx` command type (e.g., `/model` → `<ModelPicker>` → `<Pane>` with `<Select>`, `<EffortLevelIndicator>`, `<Byline>` of `<KeyboardShortcutHint>`s).

Structured forms come in two shapes:

- **Single-screen** — one decision (or one decision + an inline sub-state controller). Most slash forms (`/model`, `/agent`, future `/rename`, `/resume`).
- **Tabbed** — multi-view surface where a tab strip replaces the title row and the body re-renders per active tab while a shared `<KeyHints>` footer persists. Claude Code uses this for `/status` (Settings · Status · Config · Usage · Stats); TeXRA mirrors it for `/status` and future cross-cutting views like `/settings`. `Tab` / `Shift-Tab` cycle; direct invocation `/status usage` opens straight to a tab.

See [mockups/2026-05-15-09-slash-form.md](./mockups/2026-05-15-09-slash-form.md) for both visual targets.

### Image attachments

Pasted images are auto-numbered (`Image #1`, `Image #2`, …) and held in `cliState.attachments: Map<id, AttachmentRef>`. They surface in:

- the `/` palette under a `─── attachments ───` section, alongside slash commands, agents, models, and files (mockup 06);
- the `@` autocomplete (same source).

Selecting an attachment inserts the literal token `[Image #N]` at the input cursor. At send time, the input parser replaces those tokens with the actual image payload (base64 + media-type per the model handler's contract). Claude Code does **not** expose pasted images in any user-facing menu — this is a TeXRA-specific UX, justified by academic workflows that paste figures and proof screenshots routinely.

Paste detection runs at the `BaseTextInput` layer using the same clipboard hooks Claude Code uses (`getImageFromClipboard()` per platform). When the bracketed-paste handler sees a paste containing image bytes (not just text), it routes the bytes into `cliState.attachments` and inserts a `[Image #N]` token in place of the literal paste.

### Session resume (deferred to a separate PRD)

The desired UX is captured in [mockups/2026-05-15-10-session-resume.md](./mockups/2026-05-15-10-session-resume.md) — a `/resume` slash form lists prior executions (by their `HistoryItem.id`, the existing execution identifier in `src/shared/schemas/historyViewMessages.ts`), and `texra chat --resume <exec-id>` / `--continue` flags bypass the picker.

The implementation **does not fit in this PRD** because today's persistence layer doesn't support transcript replay: `HistoryItem` carries `{id, timestamp, agentConfig, description?}` only (no turn-by-turn log), `StreamLogStore` is in-memory, and the extension's existing restore (`texra.restoreState` → `buildMainViewState`) restores `TaskState` (agent config + active files) and **re-runs** rather than replaying. A real per-exec-id resume needs (a) an on-disk transcript store keyed by exec id, (b) a replay path that flushes turns into the `<Static>` region without re-streaming, (c) a decision on stale-agent / model substitution.

These belong in a follow-up PRD (`cli-tui-ink/02-session-resume.md` or similar). This PRD acknowledges the gap so the v1 chat session is understood as **always a fresh start** — the existing history browser in the VS Code extension remains the only way to revisit prior conversations until the resume PRD lands.

### Intuitiveness conventions

Every modal, form, palette, and approval card carries the same set of affordances so the user always knows what to do next:

- **`›`** for the focused row in any `Select` (Ink `figures.pointer`).
- **`✓`** for the currently-active value (Ink `figures.tick`).
- **Footer `<KeyHints>`** strip with scope-specific keys first, navigation in the middle, and `Enter confirm · Esc cancel` last. Implemented as a single shared component (`tui/ui/KeyHints.tsx`); ad-hoc footer text is a review-blocker.
- **One hint vocabulary everywhere**: the status-bar bindings row (`panes/statusBarDisplay.ts`) uses the same unbracketed `key action` pairs joined by `KEY_HINT_SEPARATOR` (`·`) as `<KeyHints>` — text-only surfaces build hints through `keyHintText`, and the legacy bracketed `[key]action` format must not reappear.
- **Sub-state indicators** are inline (`● High effort  ← / → to adjust`), never in a separate dialog layer.
- **Numbered options** (`1.`–`9.`) so digit shortcuts are direct jumps without arrow-key counting.

Pattern source: Claude Code's `KeyboardShortcutHint` + `Byline` + `ConfigurableShortcutHint` design-system components, reused across `/model`, `/help`, permission dialogs.

### Tool rendering

**Shared data protocol first, hosts render second.** The data shape that reaches the UI is `ToolUseLog` (defined in `src/shared/schemas/progressView.ts`) — a flat Zod object with optional fields `toolName`, `tool`, `input: unknown`, `output: unknown`, `summary`, `error`, `isError`, `userInstruction`, `status`. Per-tool semantics live inside the `input` / `output` blobs and are unwrapped at render time by `normalizeToolUseData` (`packages/extension/src/progressView/frontend/formatters/logDataParsers.ts`): it `safeParse`s through `ToolUseLogSchema`, then inspects `toolName` plus the blobs to produce a `NormalizedToolUse` record the renderer dispatches on. There is **no schema-level discriminated union** over tool name today — `WebSearchPayloadSchema` and `WebFetchPayloadSchema` exist as siblings, not branches.

The CLI TUI uses the same `normalizeToolUseData` entry point (lifted alongside the markdown renderer into `src/shared/`), then dispatches to per-tool Ink components by `toolName`. The webview already does the same dispatch to its Lit components. Both hosts read the same `ToolUseLog` off `StreamLogStore`; only the presentation layer differs. No CLI-only fields, no TUI-only enrichments.

If per-tool payloads grow enough to deserve schema-level types, the future evolution is to move `WebSearch` / `WebFetch` / new `Bash` / `FileEdit` payload schemas into a discriminated union on `toolName`. That's a follow-up, not a v1 dependency.

A `<ToolUseCard>` base provides the common chrome (header row: tool · target · status · timing · expand hint; collapsed body; `Ctrl-O` to expand). Rich tools register a custom body renderer keyed on tool name; tools without a registration fall through to the generic compact body. Pattern lifted from Claude Code (`Tool.renderToolUseMessage` / `renderToolUseProgressMessage` / `renderToolResultMessage` / `renderToolUseRejectedMessage` / `renderToolUseErrorMessage` on the `Tool` object itself, plus `FallbackToolUseErrorMessage` / `FallbackToolUseRejectedMessage`).

For TeXRA v1, **two** rich renderers earn their cost; everything else uses the fallback:

- **Bash / shell-exec.** Live-tailed last-N-lines body with elapsed timer, exit-code on completion, truncation banner with `Ctrl-O` expand. Streaming progress overwrites the body in place per chunk.
- **Edit / MultiEdit / Write.** Embedded unified-diff body using the same `diff` + `cli-highlight` pipeline as `<EditApproval>`. Header carries summary stats (`+N / −M · K hunks`).

LaTeX-specific renderers (compile, latexdiff, BibTeX) are v1.x candidates, not v1. See [mockups/2026-05-14-08-tool-variants.md](./mockups/2026-05-14-08-tool-variants.md) for the visual targets.

Renderers are **stateless presentation components** — props in, JSX out. Tool state lives in `cliState.toolUses` (a `Map<toolUseId, ToolUseLog>` from the schema above); collapse/expand is a global `verbose` flag toggled by `Ctrl-O`, not per-tool local state. This matches Claude Code's design and avoids per-tool state machines.

## 8. Multi-agent specifics

The state shape (`streamById: Map<StreamTabId, StreamTabInfo>` + `activeStreamId: StreamTabId | null`) is inherited from the webview (`progressState.ts:66`, `store.ts:66–79`) per [Non-goals](./2026-05-14-00-overview.md#4-non-goals-explicitly-excluded) and § Architecture. Three CLI-specific points:

- **Readiness signal.** Subscribe to `setActiveStream` and `setParentStream` as primary readiness events; fall back to any transition into `RUNNING` from `StreamStatusService`. Do **not** key off `INITIALIZING → RUNNING` specifically — the existing child-stream lifecycle can produce `READY → RUNNING` instead.
- **Detach runtime patch.** `detachActiveChildren` (`executionRegistry.ts:253–269`) today calls `handle.detach()` and re-emits `updateActiveSubagents` only — it does **not** emit `setParentStream` to clear the child's `parentStreamId`. Phase 4 adds that emit so the TUI (and any future host that consumes the parent-link) promotes detached children to top-level streams.
- **Why not `Ctrl-Shift-*`.** Many terminals collapse Shift on a letter to the unshifted Ctrl chord; Ink cannot distinguish them on the smoke-test matrix. Hence `Ctrl-A` cycles forward and `Ctrl-B` returns to parent (see [2026-05-14-30-reference.md § Keymap](./2026-05-14-30-reference.md#11-keymap)).

## 9. Approvals: Promise-returning launchers with a single-owner FIFO

This replaces stderr prompts with a typed React dispatch. The implementation pattern is **Promise-returning launchers backed by one explicit FIFO**. The FIFO is the canonical pending-request store; reactive status and the foreground modal are projections of it.

`CliContext.approvalPrompt` only carries `CliPromptRequest` (`kind`, `summary`, `prompt`) — that's enough for today's free-text approval but loses the typed payload the TUI needs (the bash command string, the tool-edit `originalContent`/`proposedContent`, the plan structure, the proposal's agent metadata).

### Mechanism

- `createTuiHostInteractions` implements the session-owned approval port. It exposes one entrypoint per request kind, each of which:
  1. constructs the typed payload from the host-interaction request;
  2. appends it to the approval queue's module-private FIFO;
  3. returns a `Promise<Decision>` that resolves when the user answers.
- Inside the queue, the head item is pushed onto the `currentApproval` signal (a single-item view of the queue head, not a parallel queue). `<ApprovalModal>` reads the signal, dispatches by the payload's discriminant, and settles that item on action. Removing the head promotes the next surviving FIFO entry; bulk cancellation partitions the queue before presenting a survivor.

This gives the simplicity of `await launchBashApproval(payload)` at the call site **without** losing the ability to serialize concurrent approvals from different subagent streams.

### Wiring per event

- Tool-edit and other interactive requests enter through `createTuiHostInteractions`; policy decisions happen before typed requests reach the FIFO.
- Stream-scoped cancellation uses the same host port to remove every matching queued request atomically.
- On resolution, the modal calls today's resolvers — wiring unchanged (see § 10 event map for the per-event resolver list).
- `--approval-policy never` and `yolo` short-circuit before the queue (unchanged `immediateDecision` logic).
- `<EditApproval>` renders unified diffs via `diff` + `cli-highlight`. Keys: `y` approve, `n` reject, `e` reject-with-feedback. Long diffs paginate with a summary header and `Ctrl-O` expand — no silent truncation.

### Audit prerequisite

Before merging, confirm whether two streams can emit approval requests in the same tick. API surface is unchanged either way.

## 10. Event → component map

Every signal source already exists.

| Event                                                              | Consumer                             | Render                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `updateStreamUsage`                                                | `<Header>`                           | tokens, cost, elapsed                                                                                              |
| `updateConversationProgress`                                       | `<Header>`                           | turn / tool counts                                                                                                 |
| `updateStreamDescription`                                          | `<Header>`                           | session subtitle                                                                                                   |
| `StreamStatusService.onDidChange`                                  | `<StatusBar>`, `<InputBar>`          | status pill, prompt enabled                                                                                        |
| `StreamLogStore` (`MODEL_RESPONSE`)                                | `<ConversationPane>`                 | streaming text → `<Static>` on turn end                                                                            |
| `StreamLogStore` (`TOOL_USE`)                                      | `<ToolUseCard>`                      | header + status, expandable detail                                                                                 |
| `updateActiveSubagents`                                            | `<SubagentList>`                     | one row per `ActiveChildInfo`, tree-rendered with inline status text; elapsed time refreshes on a list-level tick. |
| `updateActiveProcesses`                                            | `<SubagentList>` (processes section) | one row per process                                                                                                |
| `updateProcessOutput`                                              | child stream view (on focus)         | stdout / stderr tail                                                                                               |
| `updateTodos`                                                      | `<TodosPlanPanel>`                   | checklist                                                                                                          |
| `updatePlan`                                                       | `<TodosPlanPanel>`                   | numbered steps, status                                                                                             |
| `setActiveStream`                                                  | `<App>` router                       | switch primary streamId                                                                                            |
| `setParentStream`                                                  | `<App>` router                       | nest child under parent                                                                                            |
| `removeStream`                                                     | `<App>` router                       | cleanup                                                                                                            |
| `updateQueuedFollowUps`                                            | `<InputBar>`                         | "queued: N" pill                                                                                                   |
| `updateToolEditApprovalBypassState` / `updateSuperYoloBypassState` | `<StatusBar>`                        | YOLO / BYPASS badge                                                                                                |
| `showBashPermission`                                               | `<BashApproval>`                     | resolver: `handleProgressViewBashApprovalAction`                                                                   |
| `showToolEditPermission`                                           | `<EditApproval>`                     | resolver: `setToolEditApprovalHandler` callback                                                                    |
| `showPlanApproval`                                                 | `<PlanApproval>`                     | resolver: `resolvePlanApproval`                                                                                    |
| `showAgentProposal`                                                | `<AgentProposal>`                    | resolver: `resolveProposal`                                                                                        |
| `showRetryRequest`                                                 | `<RetryRequest>`                     | resolver: `triggerRetry` / `cancelRetry`                                                                           |
| `showExternalInquiry`                                              | `<ExternalInquiry>`                  | resolver: `handleExternalInquiryAction`                                                                            |
