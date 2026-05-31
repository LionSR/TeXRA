# TUI Performance & Rendering Audit

Scope: the Ink/React CLI TUI under `packages/cli/src/chat/tui/`.
Branch: `claude/tui-performance-rendering-VxWB9`.
Method: read the hot-path files directly (`App.tsx`, `panes/ConversationPane.tsx`,
`panes/transcriptViewport.ts`, `panes/transcriptEntries.ts`,
`state/subscribeStreamLog.ts`, `state/cliState.ts`, `state/useSignal.ts`,
`state/useLiveNowMs.ts`) and cross-checked two fan-out investigations. Severity
reflects what was verified in source, not what was asserted.

This audit frames findings against the recurring pain points of agent TUIs:
routing, concurrent updates, unmounting renderers for invisible views, viewport
painting, terminal compatibility, and keybinding consistency. Each gap carries an
**Adversarial** counter-argument and a severity revised *after* that scrutiny.

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

Each finding below carries an **Adversarial** counter-argument (the strongest case
for *not* acting, or for the proposed fix backfiring) and a severity revised
*after* that scrutiny. Net effect: most ratings dropped, and two of the original
"easy wins" turned out to be no-ops as first stated. See the meta-conclusion — the
honest next step is to *measure*, not to patch blind.

| # | Finding | Original | Revised |
|---|---------|----------|---------|
| 1 | Coarse `streams` signal re-renders whole App tree | HIGH | **MED (measure first)** |
| 2 | Viewport slice not memoized | MED | **LOW** (naive fix is a no-op) |
| 3 | No cross-stream frame coalescing | MED | **LOW–MED** (scenario-gated) |
| 4 | Hot panes lack `React.memo` | MED | **LOW** (no-op on the entry rows) |
| 5 | Bracketed paste not capability-gated | LOW | **NON-ISSUE / risky to "fix"** |
| 6 | Shift+Enter in modals undocumented | LOW | **SKIP** |

### 1. Coarse-grained `streams` signal re-renders the whole App tree
`ConversationPane` subscribes to the entire streams Map
(`panes/ConversationPane.tsx:28`, `useSignal(cliState.streams)`), and
`patchStream` does `new Map(current)` → `streams.set(out)` on every sync
(`state/cliState.ts:202-204`), so the premise holds: a single token on *any*
stream re-renders every `useSignal(cliState.streams)` consumer plus the App
(8 subscriptions at `App.tsx:251-259`) and its child panes.

**Adversarial:** what re-renders here is *React reconciliation* of a ~dozen-node
tree — building elements, microseconds. The expensive part of a TUI is Ink's
Yoga layout + ANSI frame diff, and (a) Ink already coalesces terminal output, and
(b) `patchStream` is gated behind the 16ms per-stream throttle. During streaming
the conversation pane's content *is* changing, so it has to relayout regardless;
splitting the signal only spares the *sibling* panes (StatusBar, StreamTabsStrip,
InputBar) a reconcile pass they'd do in microseconds anyway. The refactor also
adds a real footgun: `useSignal` binds a watcher to a specific signal instance
(`state/useSignal.ts:18-26`), so a per-stream signal whose identity changes on
stream-switch must force the hook to re-subscribe, or the active pane goes stale.
**Verdict:** premise true, payoff uncertain. Revised **MED, and only with a
before/after render-count or frame measurement** — do not refactor the state model
on a hunch.

### 2. Viewport slice recomputed every render
`selectPendingEntriesForViewport(pending, maxRows, width)` runs every render
(`panes/ConversationPane.tsx:33`) with no `useMemo`.

**Adversarial:** the obvious fix — `useMemo([pending, maxRows, width])` — is a
**no-op**. `splitTranscriptEntries` pushes into a *fresh* `pending` array on every
call (`panes/transcriptEntries.ts:29-30,37,45`), so the dep identity changes every
render and the memo never hits; it would only add comparison + storage overhead.
To memoize for real you'd have to memoize `splitTranscriptEntries` too, or key on
a stable signature (last entry id + text length + count + maxRows + width) — more
surface for a stale-view bug. And the work being "saved" is already small:
`pending` is only the *non-finalized* tail, and the assistant estimate is
pre-sliced to the tail window and capped at `LIVE_TAIL_ROWS`
(`panes/transcriptViewport.ts:54-61`), so it never folds a multi-MB reply.
**Verdict:** **LOW.** Not worth the stale-key risk unless profiling fingers it.

### 3. No cross-stream frame coalescing
Each stream gets its own 16ms `setTimeout` (`state/subscribeStreamLog.ts:271`);
N concurrent child streams can fire N `patchStream` calls in one window.

**Adversarial:** this only bites with *parallel subagent* streaming — the common
single-stream case has exactly one timer and zero cascade. Even at N=3 the worst
case is bounded (~3 patches/16ms, and Ink still coalesces the actual write). A
shared frame batcher also risks *delaying a finalization paint*: the code
deliberately flushes per-stream (`flushPendingRunTraces`,
`state/subscribeStreamLog.ts:291`), and a global drain could hold a stream's last
frame behind a busier sibling. **Verdict:** **LOW–MED, scenario-gated.** Worth it
only if multi-agent runs are a headline use case and measurement shows the
cascade.

### 4. Hot panes lack `React.memo`
`ConversationPane`, `BoundedTranscriptEntry`, `LiveTranscriptEntry` are not
memoized.

**Adversarial:** memo only helps when the *parent* re-renders with *equal props*.
For the entry rows that never happens — `splitTranscriptEntries` hands them fresh
`pending` slices and the sync path clones entries (`{...entry, finalized:true}`,
`state/subscribeStreamLog.ts:239`), so prop identity changes every render and
`React.memo` is a **no-op** there. For `ConversationPane` itself the props are
primitive (`width`, `maxRows`) and stable across *unrelated* App re-renders — so
memo *would* skip a render when e.g. `slashPaletteOpen` toggles (`App.tsx:257`).
But that toggle happens on a keystroke, not during streaming; during streaming the
pane subscribes to `streams` and re-renders anyway. So the only thing memo buys is
skipping reconciliation during non-streaming UI interactions, where there's no
perf pressure. **Verdict:** **LOW** — at most memo `ConversationPane` alone;
memoing the entry rows is wasted code.

### 5. Bracketed paste not capability-gated
`usePaste` is called unconditionally in `input/BaseTextInput.tsx` while
`state/terminalCapabilities.ts` already detects `bracketedPaste`.

**Adversarial:** gating it would likely make things *worse*. Capability discovery
is async with a 250ms timeout; gate `usePaste` on it and every paste in that first
window is unprotected (the exact case — a fast paste right after launch — where
you most want protection). And enabling mode 2004 on a terminal that ignores it is
harmless; the unknown sequence is dropped. The current unconditional call may be
the pragmatically correct choice. **Verdict:** **NON-ISSUE**, possibly
intentional. Don't "fix" without a concrete terminal that breaks.

### 6. Shift+Enter behavior in modals is undocumented
Modals (`modals/ConfirmCard.tsx`, `modals/UserQuestion.tsx`, `ui/Select.tsx`)
treat Enter as confirm without discriminating Shift+Enter.

**Adversarial:** the behavior is already correct (modals have no multiline field),
and a comment documenting an *absence* of behavior is the kind of note that rots
the moment someone adds a textarea. The code is self-evident. **Verdict:**
**SKIP.**

---

## Corrections to overstated findings

The fan-out investigation flagged three things that do not survive a read of the
source. Each was independently verified as a non-issue.

- **StatusBar "ticks every second even when hidden" — NOT a real issue.** The
  `useLiveNowMs` interval is local to StatusBar and cleans up on
  `shouldTick=false` (`state/useLiveNowMs.ts:6-11`). It re-renders only StatusBar
  itself (not App), once per second, while a run is active. *Mild caveat:* that is
  one live-region repaint of the bottom chrome per second while idle-but-running —
  not literally zero, but negligible.
- **SubagentList "timer runs while hidden" — NOT a real issue.** SubagentList is
  mounted only when `bottomPanelBudget > 0` (`App.tsx:526-531`); when hidden it is
  unmounted and its interval is cleared. No leak.
- **Forms/modals "remain mounted while inactive" — NOT a real issue.** They are
  conditionally rendered via `foregroundKind` and unmounted on close
  (`App.tsx:347-415`).

---

## Meta-conclusion

After the adversarial pass, the audit's own headline shrinks: nothing here is a
confirmed hang, two of the "easy wins" (#2 viewport `useMemo`, #4 `React.memo` on
entry rows) are **no-ops** because the data path hands fresh array/object
identities every render, and two more (#5, #6) are best left alone. What remains
is bounded wasted work whose real-world cost is unknown because the expensive
layer (Ink Yoga layout + ANSI diff) is already output-throttled and gated by the
16ms patch throttle.

**The honest next step is to measure, not to patch.** Concretely:

1. Add a render-count / frame-write probe (e.g. count `patchStream` calls, App
   renders, and Ink frame writes per second) and capture a baseline under
   (a) a single long streaming reply and (b) a parallel multi-subagent run.
2. Only if the numbers show a real ceiling being hit:
   - #1 (per-stream signal isolation) is the one structural change with plausible
     payoff — but it touches the state model, so do it behind the measurement.
   - #3 (shared frame batcher) only if the multi-stream cascade is what shows up.
3. #2/#4 should be done *correctly* (stable memo keys) or not at all; as naively
   stated they cost more than they save.

In short: this branch may legitimately ship **no code change** and instead land
the measurement harness that tells you whether any of #1/#3 are worth it.
