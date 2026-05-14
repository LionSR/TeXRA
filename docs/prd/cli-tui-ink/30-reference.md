# 30 · Reference

## 11. Keymap

| Key                 | Action                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Enter`             | Send message (suppressed during bracketed paste — see [10-architecture § Input component](./10-architecture.md#input-component)) |
| `Ctrl-J`            | Newline (kills `/multi` ceremony)                                                                                                |
| `Tab`               | Autocomplete (file, slash, agent, model)                                                                                         |
| `↑` / `↓`           | History (input) / row navigation (lists, modals)                                                                                 |
| `Ctrl-R`            | Reverse history search                                                                                                           |
| `Ctrl-P`            | Command palette                                                                                                                  |
| `Ctrl-A` / `Ctrl-B` | Cycle active child / back to parent (avoiding `Ctrl-Shift-A`, which collapses to `Ctrl-A` on many terminals)                     |
| `0`                 | Jump back to root stream                                                                                                         |
| `1`–`9`             | Jump to subagent row                                                                                                             |
| `Ctrl-T`            | Tab view (Conversation / Subagents / Todos+Plan / Logs)                                                                          |
| `Ctrl-L`            | Clear screen (scrollback preserved)                                                                                              |
| `Ctrl-C`            | Interrupt active session; second tap exits                                                                                       |
| `Ctrl-D`            | Exit on empty input                                                                                                              |
| `Esc`               | Close modal / palette / cancel inline edit                                                                                       |
| `?`                 | Inline help overlay                                                                                                              |
| `y` / `n` / `e`     | Approve / reject / reject-with-feedback                                                                                          |
| `@`                 | File-picker autocomplete                                                                                                         |
| `/`                 | Slash-command palette                                                                                                            |

## 12. Rendering parity with the webview

| Concern         | Webview                                                                    | CLI TUI                                                                                                   |
| --------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Markdown        | `markdown-it` + `markdown-it-texmath` w/ LRU cache (cap 500)               | Same `markdown-it` instance + thin ANSI rule plugin + **same LRU cache** (lifted into `@shared/markdown`) |
| Code fences     | `highlight.js` via `@shared/highlighting` (`highlightCode.ts` → `hljs.ts`) | Same module's tokenizer; `cli-highlight` renders the tokens to ANSI                                       |
| Math            | `katex` → HTML                                                             | `unicodeit` for inline; block math raw in v1                                                              |
| Diff            | Monaco diff editor                                                         | `diff` + `cli-highlight`                                                                                  |
| Tool cards      | Lit component per messageType                                              | Ink component per messageType                                                                             |
| Subagent badges | `BackgroundTasksPanel.ts`                                                  | `<SubagentList>` (same data, same `setActiveStream` on activate)                                          |
| Follow-up input | `FollowUpInput.ts` textarea                                                | `<InputBar>` with `/` palette + `@` mention + bracketed-paste-aware submit                                |

Two TUI features the webview does **not** have today: a slash-command palette, and an `@`-mention file picker (implementation per [10-architecture § Tech stack](./10-architecture.md#5-tech-stack-locked); risk in R8). Both are pure additions and can later land in the webview behind the same registry.

## 16. Risks

- **R1.** `markdown-it` runs in browser today; CLI use requires confirming no DOM dependencies in the existing renderer. _Mitigation:_ spike during Phase 3; fall back to `marked` + custom rule set if needed.
- **R2.** `cli-highlight` / `highlight.js` grammar-load cost on first fence (~10 ms per language). _Mitigation:_ lazy-load on first code fence; cache loaded languages globally. The workspace already includes the grammars via `@shared/highlighting/hljs.ts`.
- **R3.** Lifting webview-side `markdownRenderer.ts` upward violates `packages/extension` → CLI direction. _Mitigation:_ move the module into `src/shared/` since it's pure rendering with no VS Code coupling.
- **R4.** Ink `<Static>` + `<Box>` interaction in tmux / screen. Established as workable by Claude Code; verify in smoke matrix.
- **R5.** Bundle size: react 19 + ink 6 + highlight.js languages ≈ 600–900 KB. Acceptable for a CLI; flag at review.
- **R6.** Windows TTY edge cases (Ctrl-J = LF on some terminals, non-VT100 sequences). _Mitigation:_ test on Windows Terminal + ConHost; rely on Ink's key normalization and the runtime capability discovery from `terminalCapabilities.ts`.
- **R7.** Resource path resolution (`resolveResourcesPath` in `cliContext.ts:290–299`) changes once the package is published rather than linked. Tracked separately; not Ink-specific.
- **R8.** No `WorkspaceProvider.findFiles` exists; v1 uses CLI-local `fast-glob` against `getWorkspacePath()`. Cross-host parity (a VS Code-aware `findFiles` port) is a separate platform change — not blocking.
- **R9 (new).** **tmux / GNU screen OSC 52 clipboard silently drops.** `clipboardy`'s OSC 52 fallback writes a bare `ESC ] 52 ; ... ST` sequence; tmux requires the sequence to be wrapped in `DCS tmux; allow-passthrough; ... ST` with escaped inner ESCs, and screen requires its own DCS wrap. Without these wrappers, "copy last response" silently fails for users in nested terminals — a routine SSH workflow. _Mitigation:_ document the v1 limitation; add multiplexer-aware OSC wrapping as a follow-up. Pattern reference: Claude Code `src/ink/termio/osc.ts`.
- **R10 (new).** **No selection across scrollback.** Stock Ink does not retain text that scrolls out of the viewport when the user drag-selects, so copying a proof or block that spans multiple screens snaps to the visible portion. Claude Code's `src/ink/selection.ts` keeps `scrolledOffAbove`/`scrolledOffBelow` arrays to reconstruct logical lines; we are not adopting that fork in v1. _Mitigation:_ keyboard "copy last response" via clipboardy works for whole-message copy; document the gap.
- **R11 (deferred — not adopted in v1).** **No mouse text selection.** Out of scope per [00-overview § Non-goals](./00-overview.md#4-non-goals-explicitly-excluded).
- **R12 (new).** **React Compiler build pre-pass.** The compiler is a Babel plugin; running it before `esbuild` adds a build step the existing pipeline doesn't have. _Risks:_ (a) toolchain bloat, (b) compiler emits incorrect memoization for some patterns (rare with React 19's compiler-runtime, but possible). _Mitigation:_ gate the compiler on `packages/cli/src/chat/tui/` only — not on host-agnostic core. Validate output by checking that `react/compiler-runtime` is the only added import. If the compiler regresses behavior, disable the pre-pass and accept manual memoization.

## 17. Success criteria

- Every event in [10-architecture § Event map](./10-architecture.md#10-event--component-map) renders in the TUI with visible parity to the VS Code Progress View on the same agent run.
- A user completes a 3-subagent run, approves two edits, and rejects one bash command without typing a single slash command.
- A user pastes a 50-line LaTeX block and sees **one** submission (not 50), with the full block in the input buffer ready for review before sending.
- `texra run --output-format ndjson` output byte-identical before/after.
- `texra chat --legacy-renderer` byte-identical to today.
- `texra chat | tee transcript.txt` produces a clean ANSI-free transcript (or plain-text transcript with `--print`).
- Frame telemetry trace logs land in the standard logger and can be filtered to show flicker events with `triggerY` / `prevLine` / `nextLine` context.
- **New runtime deps:** `react`, `ink`, `@inkjs/ui`, `ink-text-input`, `citty`, `@clack/prompts`, `picocolors`, `string-width`, `wrap-ansi`, `p-queue`, `diff`, `cli-highlight`, `fast-glob`, `fzf-for-js`, `terminal-link`, `clipboardy`, `unicodeit`.
- **New dev deps:** `ink-testing-library`, `node-pty` (PTY-driven integration tests), `babel-plugin-react-compiler` (build pre-pass for `tui/*.tsx`).
- Existing `markdown-it` + `markdown-it-texmath` lifted from `packages/extension/src/progressView/frontend/formatters/` into `src/shared/markdown/` **with the LRU token cache preserved**. Existing `@shared/highlighting` (highlight.js) consumed as-is.

## 18. References

**CLI surfaces (current):** `packages/cli/src/runtime/cliContext.ts:44–268` · `packages/cli/src/commands/root.ts:66–113, 323` (`splitRunArgs`) · `packages/cli/src/chat/terminalRenderer.ts:20–367, 513–524` · `packages/cli/src/chat/runChat.ts:58–66, 109–141, 255–304, 451–511` · `packages/cli/src/runtime/logSinks.ts:87–196` · `packages/cli/src/runtime/runtimeHost.ts:37–69` · `packages/cli/src/runtime/approvalAdapter.ts:89–94, 268–270`.

**Webview reference topology:** `packages/extension/src/progressView/frontend/progressState.ts:66` (appState declaration) · `packages/extension/src/progressView/frontend/store.ts:66–79` · `packages/extension/src/progressView/frontend/formatters/markdownRenderer.ts:6–53` · `packages/extension/src/progressView/frontend/components/{BackgroundTasksPanel,TexraDiffView,FollowUpInput,ToolEditRequestPanel,BashRequestPanel,ProposalRequestPanel,PlanApprovalRequestPanel,ExternalInquiryPanel}.ts`.

**Shared infrastructure:** `src/shared/schemas/identifiers.ts` (`StreamTabIdSchema`) · `src/shared/highlighting/{highlightCode.ts, hljs.ts}` (highlight.js wrapper) · `src/agent/runtime/{StreamStatusService.ts:33–72, ExecutionHandle.ts:104–106, executionRegistry.ts:32–205, 253–269}` · `src/eventBus/ProgressEventBus.ts:60–227` · `src/logger/{StreamLogStore.ts:95–114, AgentLogger.ts:130–587, structuredLogger.ts}` · `src/platform/interfaces/{workspace.ts, storage.ts}` · `src/platform/platform.ts` + `defaults/` · `docs/pocketflow/`.

**External patterns adopted from Claude Code TUI** (`/Users/siruilu/Local/AI-Projects/claude-code-main 2/`):

- `src/ink/terminal-querier.ts` — DA1-sentinel runtime capability discovery (10-architecture § Terminal capability discovery).
- `src/components/BaseTextInput.tsx` + `src/hooks/usePasteHandler.tsx` — paste-aware text input wrapper (10-architecture § Input component).
- `src/components/Markdown.tsx` — `TOKEN_CACHE_MAX=500` lexer cache (10-architecture § Markdown token LRU cache).
- `src/ink/frame.ts` — `FrameEvent` per-phase timings and flicker context (10-architecture § Frame telemetry).
- `src/main.tsx` + `src/ink/ink.tsx` — `stdout.isTTY`-gated chrome with `--print` fallback (20-implementation § Headless).
- `src/dialogLaunchers.tsx` — `Promise<T>`-returning dialog launchers with `done` callback resolution (10-architecture § Approvals).
- `src/ink/termio/osc.ts` — multiplexer-aware OSC wrapping (R9, deferred).
- `src/ink/selection.ts` — scrollback-aware selection state (R10, deferred).
