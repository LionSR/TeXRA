# Thinking Blocks Render as Plain Info Logs Before Finalizing (#7276)

**Status:** Proposed.
**Scope:** `packages/extension/src/progressView/frontend/formatters/index.ts` (`isStreamingTextLogMessage`, `formatLogEntry`), `formatters/logFormatters/bannerFormatters.ts` (`formatBannerContentTemplate`, `formatModelResponseTemplate`), and the orphan-sweep in `src/transcript/StreamLogStore.ts`.
**Out of scope:** CLI TUI rendering of thinking content (`packages/cli/src/chat/tui/`) — a separate renderer, not reported as buggy; verify independently if the same symptom shows up there. Also out of scope: reworking `MESSAGE_TYPES`/`StreamLogEntry` schemas.
**Related:** the perf change that introduced this, commit `0807dc345` ("perf: stream transcript text deltas", closed #6969).

## TL;DR — verdict

The issue title ("thinking blocks become info logger before finalizing") is literally what the code does, on purpose. `formatLogEntry` (`formatters/index.ts:169-176`) special-cases `thinking`/`scratchpad`/`modelResponse` entries whose `data.status === 'running'`: instead of the collapsible `<details>` banner (light-bulb icon, chevron, copy button), it renders the bare `formatDefaultLogMessageTemplate` — the same flat `<div class="log-line">` used for ordinary info/debug logs, distinguished only by a small level icon. Only when the stream finalizes (`data.status: 'completed'`) does the entry repaint through `formatBannerContentTemplate` and get the real banner. This was a deliberate perf tradeoff in `0807dc345`, to avoid re-running `processMarkdownContent` (full markdown parse) on every streamed delta chunk — but the visible cost is that a thinking block is indistinguishable from an unrelated log line for its entire in-flight lifetime, which is most of what a user watches.

Two secondary findings from tracing this:

- **Orphaned running entries never recover.** If a run is cancelled, crashes, or the extension/webview reloads while a thinking stream is mid-flight, nothing ever flips that entry's `data.status` to `completed`. It renders as a plain log line forever, even after reload. `StreamLogStore.ts:430-456` already sweeps orphaned `GROUP_START` stage entries (`endRunningGroupsInLoadedLogs`) but has no equivalent for orphaned streaming-text `LOG` entries.
- **The original triage comment's flagged call sites don't reproduce this.** `ResponseCycleFlow.ts:293-297` and `ToolUseProcessNode.ts:113-120` call `logger.info(thinkingContent, { messageType: MESSAGE_TYPES.THINKING })` with no `data` option. `isRunningData(undefined)` is `false`, so `isStreamingTextLogMessage` is `false` for these, and they dispatch straight to the banner formatter on their one and only paint. They should be left alone; the issue thread's triage should be corrected.

## Proposed fix

Keep the banner shell (icon, "Thinking"/"Scratchpad"/"Assistant" label, chevron, copy button) mounted for the entire life of the entry — from the first chunk to finalize — so it never looks like a generic log line. Preserve the perf win by skipping markdown parsing only, not the whole banner, while running:

1. **`bannerFormatters.ts`**: `formatBannerContentTemplate` and `formatModelResponseTemplate` gain running-state awareness. When `message.data` has `status: 'running'`, render the trimmed text as a plain Lit text binding (cheap, escaped, no `unsafeHTML`/`processMarkdownContent` call) inside the same `banner-content` div/class used today; when not running (`undefined` or `completed`), keep the existing `processMarkdownContent` + `unsafeHTML` path. Force `shouldOpen = true` while running, so the block is expanded and visibly "live" rather than defaulting closed.
2. **`formatters/index.ts`**: delete the `isStreamingTextLogMessage` short-circuit in `formatLogEntry` (`:169-176`) so `thinking`/`scratchpad`/`modelResponse` entries always dispatch through `TEMPLATE_FORMATTERS`, running or not. `STREAMING_TEXT_TYPES`/`isRunningData` can be kept (or moved) as the predicate the banner formatters now consume directly.
3. **Orphan sweep**: extend the existing stuck-`GROUP_START` sweep pattern (`StreamLogStore.ts:430-456`, `isRunningGroupEntry` in `StreamLog.ts:18-23`) to also finalize any `LOG`-type entry whose `data.status === 'running'` on load — flip it to `data.status: 'completed'` with no other mutation. This is independent of (1)/(2) and closes the "stuck forever after crash/cancel/reload" case.
4. **Issue correction**: post a follow-up on #7276 noting the two non-streaming call sites the original triage flagged are not implicated, per current code — no change needed there.

This removes the plain-log flash entirely: a thinking/scratchpad/model-response entry is a `<details>` banner from its first chunk, with cheap raw-text updates while streaming and a one-time markdown upgrade at finalize — matching the perf goal of #6969 (no per-chunk markdown reparse) without the regression.

## Verification plan

- Extend `LogDeltaTextDeltas.vitest.ts` (or add alongside it) to assert `formatLogEntry` produces a `banner-details` shell — not a `log-line` — for a `thinking` message with `data.status: 'running'`.
- Manual: run a slow-streaming provider (e.g. Anthropic extended thinking) and watch the live transcript — the banner shell should appear on the first chunk and grow in place, then flip to markdown-rendered content at finalize, with no re-mount/flash.
- Manual: cancel a run mid-thinking-stream, reload the extension/webview, confirm the entry finalizes instead of staying stuck as `running`.
