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

Chrome is gated on `stdout.isTTY` only (not the full `cliMode()` check), so `texra chat | tee` works.

### TTY/non-TTY decision matrix

| stdin | stdout | stderr | Behavior                                                                                                                                                                                                                            |
| ----- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTY   | TTY    | TTY    | **TUI** — full Ink rendering, raw-mode input, alt-screen optional, approval modals, paste handling.                                                                                                                                 |
| TTY   | piped  | TTY    | **Streaming text** — `BaseTextInput` reads from stdin TTY, but ConversationPane writes plain ANSI text to stdout (no `<Box>` chrome, no cursor moves, no alt-screen). Approval modals route to stderr. Enables `texra chat \| tee`. |
| piped | \*     | \*     | **Headless** — existing `texra run`-equivalent path. No interactive input. `--print/-p` is the canonical invocation.                                                                                                                |
| any   | any    | piped  | **Headless** — same as above; status output is structured.                                                                                                                                                                          |

The detection point is the `stdout.isTTY` check in the `<App>` setup before `render()`. When `false`, the app mounts in "stream" mode: same React tree, but ConversationPane outputs to stdout via a plain-text serializer rather than ink's renderer-driven output.

### What's preserved

- `texra run`, `--print/-p`, non-TTY chat over `CI=true`, and `--output-format ndjson` — Ink chrome never loads. `NdjsonStdoutSink` and its drain/backpressure logic remain in `logSinks.ts` for the headless `--output-format ndjson` path; they are not touched by this PRD.
- `--legacy-renderer` flag retains today's plain renderer (also auto-forced on `TERM=dumb` or `NO_COLOR` + narrow `COLUMNS`). The legacy renderer becomes the only consumer of `picocolors` after migration; everything else lives in Ink.
- `--output-format json|ndjson` output byte-identical. Golden test in `packages/cli/scripts/validate-run.mjs`.

### Explicit `--print` mode

A new `--print` flag forces the streaming-text mode regardless of TTY status, so scripts and pipelines can opt into deterministic plain output without depending on environment detection. Maps to the same code path as the auto-detected `stdout` non-TTY case above.

## 14. Migration phases

Every phase is independently mergeable. Each adds a `--tui` flag, default-off, until Phase 6.

### Phase 0 — Foundation (1–2 d)

- Add `react@19`, `ink@6`, `@inkjs/ui`, `citty`, `picocolors`, `string-width`, `wrap-ansi`.
- **Wire React Compiler.** Add `babel-plugin-react-compiler` and run a Babel pre-pass over `packages/cli/src/chat/tui/**/*.tsx` before esbuild. Validate output by smoke-running a hello-world `<App>` and confirming `react/compiler-runtime` is the only added import. Risk R12.
- Migrate `cliContext.ts` arg parsing to `citty` (no UI change). Drop `ANSI_TONES` for `picocolors` in legacy renderer.
- Verify headless tests + `validate-run.mjs` pass.

### Phase 1 — Skeleton + input + telemetry (2–3 d)

Implements components per 10-architecture §§ Input component, Terminal capability discovery, Terminal notifications, Frame telemetry.

- Skeleton `<App>` (Header + InputBar + ConversationPane, MODEL_RESPONSE only) behind `--tui`; wire `cliState` signal subscriptions.
- `BaseTextInput` with paste handling, viewport, declared-cursor.
- `terminalCapabilities` discovery; notifier ships `agentFinished` + `approvalNeeded` (progress deferred to Phase 4).
- Frame telemetry on ink's `onFrame`; coalesce SIGWINCH events (R13).
- Non-TTY stdout fallback + `--print` flag.
- `p-queue`-backed follow-ups. Approvals still on legacy adapter.

### Phase 2 — Tool & approval rendering (3 d)

- `<ToolUseCard>`.
- Replace `installCliApprovalHandlers` with the typed TUI installer per [10-architecture § Approvals](./10-architecture.md#9-approvals-promise-returning-launchers-with-a-concurrency-1-queue). Each `launchX(payload)` returns `Promise<Decision>`; the approval `p-queue` (`concurrency: 1`) serializes them.
- All six approval modals dispatched off the typed queue.
- `<DiffView>` using `diff` + `cli-highlight`.
- Resolver wiring unchanged.
- **Audit** (prerequisite for closing the phase): confirm whether subagent and main-stream approvals can interleave; document the finding in the PR description. Either outcome leaves the API identical.

### Phase 3 — Markdown + code + token cache (2 d)

- Lift the webview's `markdownRenderer.ts` into a shared `@shared/markdown` module **as a configurable factory**, not a frozen singleton. Today's singleton hard-wires the `texmath`/`katex` math engine and an HTML output renderer (`packages/extension/src/progressView/frontend/formatters/markdownRenderer.ts:39–53`); the CLI host needs a different math engine (`unicodeit` / raw passthrough per [§ Tech stack](./10-architecture.md#5-tech-stack-locked)) and an ANSI renderer instead of HTML. The factory takes a math-engine option and a renderer hook; the webview keeps its current configuration, the CLI host supplies its own.
- **Preserve the LRU token cache** (cap 500) when lifting. Streamed responses re-render on every chunk; without the cache, re-lexing the full buffer per chunk dominates render cost.
- Code fences delegate to `cli-highlight`, reusing the grammars `@shared/highlighting/hljs.ts` already pulls from `highlight.js/lib/core`. Lazy-load language packs (first-fence latency ~10 ms acceptable; risk R2).
- Wire `<Markdown>` and `<CodeBlock>` into `ConversationPane`.

### Phase 4 — Multi-agent + tabs (2 d)

- `<SubagentList>`, `<TodosPlanPanel>`, `<StatusBar>`.
- `Ctrl-A` / `Ctrl-B` focus cycle. Stream switching via `setActiveStream`.
- Process output tailing.
- **Runtime patch:** have `detachActiveChildren` (`executionRegistry.ts:253–269`) emit `setParentStream` so detached children promote to top-level streams.

### Phase 5 — Ergonomics (2 d)

- `Ctrl-P` palette (`fzf-for-js`).
- `Ctrl-R` reverse history (input lines).
- `Ctrl-F` transcript search per [10-architecture § Transcript search](./10-architecture.md#transcript-search).
- `Ctrl-O` expand affordance for truncated content.
- `@` file picker.
- `/` command palette, autocomplete on `/agent` & `/model`.
- Input history file per [10-architecture § Tech stack](./10-architecture.md#5-tech-stack-locked).

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
- **Non-TTY fallback.** Run `texra chat --tui --print` and `texra chat --tui < /dev/null | tee out.txt` and assert plain text streams to stdout with no ANSI cursor codes.
- **Terminal notifications.** Notifier emits only the sequences the terminal acknowledged at startup.
- **Transcript search highlighting.** Correct on composed characters, wide chars (CJK), and overlapping substrings.
- **Headless regression.** Existing `texra run` golden outputs unchanged. `--legacy-renderer` keeps the existing plain-mode tests green.
- **Capability discovery.** Mock a stdin with a DA1 reply but no Kitty-keyboard reply; assert the capabilities signal records Kitty as unsupported without timing out.
