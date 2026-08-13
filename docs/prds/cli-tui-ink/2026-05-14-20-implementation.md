---
created: 2026-05-14
updated: 2026-06-13
---

# 20 · Implementation

## 6. Wheels to drop

Each entry is a deletion candidate, not a wrapper.

| Today                                                                                                 | Where                                         | Replace with                                                                                     |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `splitGlobalArgs`, `flagValue`, `cliFlagName`, `hasBooleanFlag`, three `FLAGS_WITH_VALUE` sets        | `cliContext.ts:44–166, 224–268`               | `citty` `defineCommand`                                                                          |
| `splitRunArgs` (separate file — citty migration touches two)                                          | `commands/root.ts:66–113` (invoked at `:323`) | `citty` subcommand args                                                                          |
| `ANSI_TONES`, tone-switching `write()`                                                                | `terminalRenderer.ts:20–27, 546–552`          | `picocolors` in legacy; Ink `<Text color>` in TUI                                                |
| `truncateText`, `formatOutputSnippet`, `formatUnknownSnippet`                                         | `terminalRenderer.ts:61–64, 310–367`          | `string-width` + `wrap-ansi`                                                                     |
| `renderedToolUseSignatures` `JSON.stringify` dedup                                                    | `terminalRenderer.ts:181–183`                 | `useSyncExternalStore` + React `memo` keyed on `entry.id + entry.seqNo`                          |
| `MultilineDraftState` + `/multi` `/send` `/cancel` plumbing                                           | `runChat.ts:63–66, 451–469, 507–511`          | `BaseTextInput` with `Ctrl-J` newline + bracketed-paste-aware submit; `/multi` retained as alias |
| `followUpFlush` promise chain, `pendingFollowUps`, `flushPendingFollowUps`, `streamReadyForFollowUps` | `runChat.ts:58–61, 255–304`                   | `p-queue` (`concurrency: 1`)                                                                     |
| `askCliQuestion`, `createCliLineReader`                                                               | `logSinks.ts:87–107`                          | `@clack/prompts` outside TUI; Ink inside                                                         |
| `installChatResponsePrinter` log-diff loop                                                            | `runChat.ts:109–141`                          | `useStreamLog(streamId)` hook + `<Static>` for finalized turns                                   |
| ASCII card rendering (`-- title --` / `\| line` form)                                                 | `terminalRenderer.ts:513–524`                 | Ink `<Box borderStyle="round">`                                                                  |

Net: roughly 400 LOC removed from the TUI mode; the `--legacy-renderer` path retains the subset it actually uses (notably the ASCII card form, `askCliQuestion`, and the multiline draft state), so the deletion is bounded by which renderer is active.

## 13. Headless & legacy preserved

Today's `cliMode()` (`cliContext.ts:214–222`) collapses to `headless` whenever any of stdin / stdout / stderr is non-TTY, so `texra chat | tee` fails. This PRD splits the existing single gate into two:

1. **Headless gate (narrowed):** triggered by `--print/-p`, `CI=true`, or stdin non-TTY. `--print/-p` keeps its existing semantics (`cliContext.ts:66, 202`) — no flag change. The behavior change is in `cliMode()` itself: `!ambient.stdoutIsTty` and `!ambient.stderrIsTty` are dropped from the headless OR-chain, so piping stdout or stderr alone no longer forces headless.
2. **TUI chrome gate (new):** Ink chrome mounts only when `stdout.isTTY`. When stdout is piped but stdin is TTY and headless is not forced, the app mounts in a "streaming-text" mode — same React tree, but the conversation pane writes plain ANSI to stdout instead of going through ink's renderer.

### Decision matrix

| stdin | stdout | stderr | `--print`? | Behavior                                             |
| ----- | ------ | ------ | ---------- | ---------------------------------------------------- |
| TTY   | TTY    | TTY    | —          | **TUI**                                              |
| TTY   | piped  | TTY    | —          | **Streaming text** (enables `texra chat \| tee`)     |
| TTY   | any    | any    | yes        | **Headless** (today's `--print` behavior, unchanged) |
| piped | any    | any    | —          | **Headless** (today's behavior, unchanged)           |
| —     | —      | —      | `CI=true`  | **Headless** (today's behavior, unchanged)           |

The new streaming-text mode is exactly the gap created by gating chrome on `stdout.isTTY` while leaving headless on the narrowed OR-of-three defined above (the OR-of-five today's `cliMode()` runs on is collapsed by dropping `!stdoutIsTty` and `!stderrIsTty`).

### What's preserved

- `texra run`, `texra agents run`, `--print/-p`, `CI=true`, and
  `--output-format ndjson` — Ink chrome never loads. `NdjsonStdoutSink` and its
  drain/backpressure logic remain in `logSinks.ts` for the headless
  `--output-format ndjson` path; they are not touched by this PRD.
- `--legacy-renderer` flag retains today's plain renderer (also auto-forced on `TERM=dumb` or `NO_COLOR` + narrow `COLUMNS`). The legacy renderer becomes the only consumer of `picocolors` after migration; everything else lives in Ink.
- `--output-format json|ndjson` output byte-identical. Golden test in `packages/cli/scripts/validate-run.mjs`.

## 14. Migration phases

Every phase is independently mergeable. Each adds a `--tui` flag, default-off, until Phase 6.

### Phase 0 — Foundation (1–2 d)

- Add `react@19`, `ink@6`, `@inkjs/ui`, `citty`, `picocolors`, `string-width`, `wrap-ansi`.
- **Wire React Compiler.** Add `babel-plugin-react-compiler` and run a Babel pre-pass over `packages/cli/src/chat/tui/**/*.tsx` before esbuild. Validate output by smoke-running a hello-world `<App>` and confirming `react/compiler-runtime` is the only added import. Risk R12.
- Migrate `cliContext.ts` arg parsing to `citty` (no UI change). Drop `ANSI_TONES` for `picocolors` in legacy renderer.
- **Default subcommand:** wire `texra` (no args) to invoke the interactive
  launcher (`texra orchestrate`) when stdin / stdout are TTYs, falling through
  to `--help` otherwise. Citty's `defaultSubCommand` field.
- **Default agent + model resolution.** Implement the four-step lookup
  (workspace → user → last-used → built-in) per
  [§ Entrypoint default](./2026-05-14-10-architecture.md#entrypoint-default). `texra chat`
  reaches this resolver before mounting `<App>`, so the header always shows a
  concrete agent + model; bare `texra` reaches it after the launcher starts a
  new chat.
- Verify headless tests + `validate-run.mjs` pass.

### Phase 1 — Skeleton + input + telemetry (2–3 d)

Implements components per 10-architecture §§ Input component, Terminal capability discovery, Terminal notifications, Frame telemetry.

- Skeleton `<App>` (Header + InputBar + ConversationPane, MODEL_RESPONSE only) behind `--tui`; wire `cliState` signal subscriptions.
- `BaseTextInput` with paste handling, viewport, declared-cursor.
- `terminalCapabilities` discovery; notifier ships `agentFinished` + `approvalNeeded` (progress deferred to Phase 4).
- Frame telemetry on ink's `onFrame`; coalesce SIGWINCH events (R13).
- Streaming-text fallback when stdout is piped (per [§ 13](#13-headless--legacy-preserved)); no new flag.
- `p-queue`-backed follow-ups. Approvals still on legacy adapter.

### Phase 2 — Tool & approval rendering (3 d)

- `<ToolUseCard>`.
- Replace `installCliApprovalHandlers` with the typed TUI installer per [10-architecture § Approvals](./2026-05-14-10-architecture.md#9-approvals-promise-returning-launchers-with-a-single-owner-fifo). Each `launchX(payload)` returns `Promise<Decision>`; one explicit FIFO serializes them and projects its head into the modal signal.
- All seven approval/request modals dispatched off the typed queue.
- `<DiffView>` using `diff` + `cli-highlight`.
- Resolver wiring unchanged.
- **Audit** (prerequisite for closing the phase): confirm whether subagent and main-stream approvals can interleave; document the finding in the PR description. Either outcome leaves the API identical.

### Phase 3 — Markdown + code (2 d)

- Lift the webview's `markdownRenderer.ts` into a shared `@shared/markdown` module as a configurable factory, not a frozen singleton. Today's singleton hard-wires the `texmath`/`katex` math engine and an HTML output renderer; the CLI host needs a different math engine and an ANSI renderer. The factory takes a math-engine option and a renderer hook; the webview keeps its current configuration, the CLI host supplies its own. (R3: the lift also has to drop or replicate the `katexMacros` import that lives in `packages/extension/`.)
- Add a parallel render-result cache for the CLI host (the webview's existing cache stores HTML and is not reusable for ANSI). Match the existing budget shape (per-entry + total-char caps).
- Code fences delegate to `cli-highlight`, reusing the grammars `@shared/highlighting/hljs.ts` already pulls from `highlight.js/lib/core`. Lazy-load language packs (R2).
- Wire `<Markdown>` and `<CodeBlock>` into `ConversationPane`.

### Phase 4 — Multi-agent + tabs (2 d)

- `<SubagentList>`, `<TodosPlanPanel>`, `<StatusBar>`.
- `Ctrl-A` / `Ctrl-B` focus cycle. Stream switching via `setActiveStream`.
- Process output tailing.
- **Runtime patch** (non-doc code change — lands outside this PR's scope): have `detachActiveChildren` (`src/agent/runtime/executionRegistry.ts:253–269`) emit `setParentStream` so detached children promote to top-level streams. Today's path only calls `handle.detach()` and `emitActiveSubagentsUpdate`.

### Phase 5 — Ergonomics (2 d)

- `Ctrl-P` palette (`fzf-for-js`) with five sections: slash commands, agents, models, attachments, files.
- **Structured slash forms** (per [10-architecture § Slash command forms](./2026-05-14-10-architecture.md#slash-command-forms)). Ship `/model` (single-screen) first; tabbed-form scaffold (`Tab` / `Shift-Tab` cycle, shared footer) ships alongside for `/status`. `/agent` reuses the same primitives. `/resume` is deferred to a follow-up PRD (needs new on-disk transcript persistence — see [§ Session resume](./2026-05-14-10-architecture.md#session-resume-deferred-to-a-separate-prd)).
- **Image-paste attachments** (per [§ Image attachments](./2026-05-14-10-architecture.md#image-attachments)). Detect clipboard image bytes at `BaseTextInput`; store in `cliState.attachments`; insert `[Image #N]` tokens; surface in palette + `@` autocomplete; expand to image-payload at send time.
- **Shared `<KeyHints>` component** mounted on every modal/form/palette per [§ Intuitiveness conventions](./2026-05-14-10-architecture.md#intuitiveness-conventions). Any ad-hoc footer text is a review-blocker for this phase.
- `Ctrl-R` reverse history (input lines).
- `Ctrl-F` transcript search per [10-architecture § Transcript search](./2026-05-14-10-architecture.md#transcript-search).
- `Ctrl-O` expand affordance for truncated content.
- `@` file picker.
- `/` command palette, autocomplete on `/agent` & `/model`.
- Input history file per [10-architecture § Tech stack](./2026-05-14-10-architecture.md#5-tech-stack-locked).

### Phase 6 — Stabilise & flip (1 d)

- `--tui` defaults on for TTY; `--legacy-renderer` becomes opt-out.
- README rewrite.
- Decide `private: true` flip (separate).
- Smoke matrix: Windows Terminal, iTerm2, macOS Terminal, GNOME Terminal, tmux, screen.

**Total:** ~12–13 dev-days, six PRs.

## 15. Testing

- **Unit.** `ink-testing-library` renders each pane / modal against synthetic runtime-host emit + `StreamLogStore` mocks. Snapshot the frame string.
- **Integration.** Extend `packages/cli/scripts/validate-run.mjs` with an interactive variant driving stdin via `node-pty` and asserting frame snapshots.
- **Approval flows.** Per-modal test that the right resolver is called with the right payload. Highest-risk wires. Also test queue serialization: enqueue two payloads back-to-back and assert the second modal does not appear until the first resolves.
- **Paste handling.** PTY test that injects `CSI 200 ~` + multi-line text + `CSI 201 ~` and asserts a single submit fires (not N).
- **Streaming-text fallback.** `texra chat --tui` with stdout piped (stdin TTY) writes color SGRs + plain text to stdout (no cursor codes, no Ink chrome); `NO_COLOR=1` strips colors. `texra chat --tui --print` continues to take the headless path unchanged.
- **Terminal notifications.** Notifier emits only the sequences the terminal acknowledged at startup.
- **Transcript search highlighting.** Correct on composed characters, wide chars (CJK), and overlapping substrings.
- **Headless regression.** Existing `texra run` golden outputs unchanged. `--legacy-renderer` keeps the existing plain-mode tests green.
- **Capability discovery.** Mock a stdin with a DA1 reply but no Kitty-keyboard reply; assert the capabilities signal records Kitty as unsupported without timing out.
