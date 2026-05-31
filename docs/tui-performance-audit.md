# TUI Performance & Rendering Audit

Scope: the Ink/React CLI TUI under `packages/cli/src/chat/tui/`.
Branch: `claude/tui-performance-rendering-VxWB9`.
Method: read the hot-path files directly (`App.tsx`, `panes/ConversationPane.tsx`,
`state/subscribeStreamLog.ts`, `state/useSignal.ts`, `state/useLiveNowMs.ts`) and
cross-checked two fan-out investigations. Severity reflects what was verified in
source, not what was asserted.

This audit frames findings against the recurring pain points of agent TUIs:
routing, concurrent updates, unmounting renderers for invisible views, viewport
painting, terminal compatibility, and keybinding consistency.

---

## What is already handled well

These are not gaps — recording them so the report is honest about the baseline.

- **Invisible views are truly unmounted (routing).** Foreground surfaces
  (approval / form / child-controls / transcript viewer) are conditionally
  rendered through a single `foregroundKind` switch and dropped on close
  (`App.tsx:347-415`). The bottom panels (`SubagentList`, `TodosPlanPanel`)
  mount only when `bottomPanelBudget > 0` (`App.tsx:526-531`). Forms are stored
  as render functions in a signal and discarded on close. No hidden view keeps a
  subtree mounted.
- **Finalized history belongs to the terminal.** Finalized entries print once
  via `<Static>` (`panes/StaticConversationTranscript.tsx`); the live region
  renders only in-flight content and is explicitly capped
  (`selectPendingEntriesForViewport`, `BOTTOM_PANEL_MAX_ROWS`). Matches the
  documented TUI discipline.
- **Single keyboard owner (keybinding consistency).** One App-level `useInput`
  gates internally on `focusShortcutsActive` / `inputDisabled` instead of
  several hooks racing on the same chord (`App.tsx:427-499`). Kitty keypad Enter
  is re-dispatched as CR so every `key.return` path keeps working
  (`App.tsx:276-288`). Escape is consistently "cancel" across modals/forms.
- **Terminal compatibility is negotiated.** DA1-sentinel capability discovery
  (`state/terminalCapabilities.ts`); notifications go OSC 99 / OSC 9 → BEL with
  capability gating (`notifications/terminalNotifier.ts:38-48`).
- **Stream chunks are throttled.** Per-stream coalescing at one animation frame
  (`STREAM_SYNC_THROTTLE_MS = 16`, `state/subscribeStreamLog.ts:257-276`).

---

## Verified gaps (prioritized)

### 1. Coarse-grained `streams` signal re-renders the whole App tree — HIGH
`ConversationPane` subscribes to the entire streams Map
(`panes/ConversationPane.tsx:28`, `useSignal(cliState.streams)`), and
`patchStream` replaces the Map on every sync. A single token on *any* stream
therefore re-renders every `useSignal(cliState.streams)` consumer plus the App
(8 signal subscriptions at `App.tsx:251-259`) and all of its child panes. This is
the "concurrent updates" cost from the brief: work scales with mounted panes, not
with what actually changed.

*Direction:* split per-stream subscriptions (e.g. a derived signal keyed by
`activeStreamId`) so only the active stream's pane reacts to its own tokens; or
isolate the conversation subtree so unrelated stream mutations don't reach it.

### 2. Viewport slice recomputed every render, no memo — MEDIUM
`selectPendingEntriesForViewport(pending, maxRows, width)` runs on every render
(`panes/ConversationPane.tsx:33`). It is pure (re-estimates wrapped rows and
rebuilds the `rowLimits` Map from the same inputs) but is not wrapped in
`useMemo`. Bounded by the 16ms throttle, so it is wasted work rather than a hang,
but it recomputes on every stream tick.

*Direction:* `useMemo` keyed on `(pending, maxRows, width)`.

### 3. No cross-stream frame coalescing — MEDIUM
Each stream gets its own 16ms `setTimeout` (`state/subscribeStreamLog.ts:271`).
With several concurrent child streams, one 16ms window can fire multiple
independent `patchStream` calls → multiple App re-renders instead of one
coordinated frame.

*Direction:* a single shared frame timer that drains all dirty stream ids in one
`patchStream`/render pass.

### 4. Hot panes lack `React.memo` — MEDIUM
`ConversationPane`, `BoundedTranscriptEntry`, `LiveTranscriptEntry` are not
memoized (`panes/ConversationPane.tsx`, `panes/TranscriptEntry.tsx`). Because
they sit under App, an unrelated signal change (e.g. `slashPaletteOpen` toggling,
`App.tsx:257`) re-renders the conversation subtree even though its inputs are
unchanged.

*Direction:* `React.memo` on the conversation panes; note that components reading
signals directly via `useSignal` still re-render on their own signal changes, so
memo helps specifically against *unrelated* App re-renders.

### 5. Bracketed paste not capability-gated — LOW (consistency)
`usePaste` is called unconditionally in `input/BaseTextInput.tsx` while the
DA1-sentinel flow already detects `bracketedPaste`
(`state/terminalCapabilities.ts`). Ink degrades gracefully, so impact is low, but
it is inconsistent with the rest of the capability-gating discipline.

### 6. Shift+Enter behavior in modals is undocumented — LOW (clarity)
Modals (`modals/ConfirmCard.tsx`, `modals/UserQuestion.tsx`, `ui/Select.tsx`)
treat Enter as confirm without discriminating Shift+Enter. This is effectively
correct (modals have no multiline field) but relies on an unstated assumption; a
one-line comment would prevent a future "Shift+Enter should newline" regression.

---

## Corrections to overstated findings

- **StatusBar "ticks every second even when hidden" — NOT a real issue.** The
  `useLiveNowMs` interval is local to StatusBar and cleans up on
  `shouldTick=false` (`state/useLiveNowMs.ts:6-11`). It re-renders only StatusBar
  itself (not App), once per second, while a run is active. Negligible.
- **SubagentList "timer runs while hidden" — NOT a real issue.** SubagentList is
  mounted only when `bottomPanelBudget > 0` (`App.tsx:526-531`); when hidden it is
  unmounted and its interval is cleared. No leak.
- **Forms/modals "remain mounted while inactive" — NOT a real issue.** They are
  conditionally rendered via `foregroundKind` and unmounted on close
  (`App.tsx:347-415`).

---

## Suggested order of work

1. **#2 + #4** — low risk, local, immediate win: memoize the viewport slice and
   add `React.memo` to the conversation panes. No state-model changes.
2. **#1 + #3** — highest payoff, but touches the state model
   (`cliState.streams` granularity and the sync scheduler), so it needs the most
   careful testing.
3. **#5 + #6** — small consistency/clarity fixes; bundle opportunistically.
