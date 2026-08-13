# Good Ink Practices from the Claude Code CLI Source, Mapped to TeXRA

> **Status:** Partially landed reference notes (2026-07-04 status sweep).
> Current TeXRA already implements the synchronous terminal-mode restoration and
> per-entry error-boundary corrections noted below; remaining practices are
> guidance to re-verify before acting.

> Source studied: a de-obfuscated dump of the real Claude Code CLI, which vendors a
> **heavily-forked Ink** under `src/ink/` (its own reconciler, screen/scrollback model,
> log-update, selection engine, terminal-capability querier, keypress parser). All
> citations below are relative to that dump's `src/`. Each practice was extracted by a
> deep-reader agent and then adversarially fact-checked against the cited code (every
> finding here carries a "confirmed" verification verdict). TeXRA notes compare against
> `packages/cli/src/chat/tui/` and the rules in `CLAUDE.md`.

## Executive Summary

Claude Code's vendored Ink fork and TeXRA's CLI TUI share the same north star — let the
terminal own scrollback, full-repaint on resize, gate features by capability — and TeXRA's
`CLAUDE.md` shows it has already internalized those hard-won lessons. The biggest divergence
is depth: where TeXRA keeps Ink's stock `<Static>`/live-region split and delegates
wrapping/diffing to upstream Ink, Claude Code replaced the entire render core with a single
packed typed-array virtual screen, cell-level damage-bounded diffing, per-node pixel
blitting, and interned styles — turning steady-state frames into O(changed cells) work. The
highest-leverage borrowables are mostly _correctness and robustness_ rather than the deep
rendering rewrite: a single shared animation Clock, offscreen-aware tick pausing, a force-exit
failsafe after TeXRA's existing synchronous terminal restoration, reference-counted raw mode, and a
`/dev/tty` fallback for piped-but-interactive stdin. TeXRA is genuinely already aligned on
scrollback ownership, resize-as-full-repaint, DA1-sentinel capability probing, headless parity, and
sync signal cleanup by construction — these are areas to validate, not rebuild. The rendering-engine
practices (packed Screen, blit, intern pools) are high-effort, lower-priority given TeXRA's
tail-window cap already bounds the practical cost.

---

## Status / corrections (verified against current TeXRA code)

The per-subsystem grounding agent surveyed `terminalCleanup.ts` but missed
`runChatTui.tsx`, so two top-list items need correcting:

- **#1 (sync `writeSync` signal teardown) is ALREADY implemented in TeXRA.**
  `runChatTui.tsx`'s `exitNow()` calls `cleanupTerminalModes()` (synchronous
  `writeSync` resetting mouse/kitty/bracketed-paste/cursor) _before_
  the async drain, and SIGINT/SIGTERM/SIGHUP are all wired to it
  (`runChatTui.tsx:819-838,846-890,918-920`). The only genuinely-missing sliver is a
  **force-exit failsafe timer** in case `drainPersistence()` / platform shutdown
  hangs — small and optional, since terminal modes are already restored
  synchronously regardless.
- **#3 (per-transcript-entry error boundaries) was the actual high-confidence gap
  and is now shipped.** `EntryErrorBoundary` wraps live transcript entries
  (`panes/ConversationPane.tsx:114-116`) and static transcript entries
  (`panes/StaticConversationTranscript.tsx:410-426`), so a render throw is isolated to
  one entry.

---

## 1. Rendering & Scrollback Model

**Let the terminal own scrollback; keep one diffed live buffer, not a Static/live split.**
Claude Code abandons Ink's `<Static>`/`<Box>` split: there is one full-height virtual
`Screen`, finalized history is just its top rows, and new content is appended with literal LF
so the _emulator_ scrolls old rows into native scrollback (`renderFrameSlice` uses LF not CSI
cursor-down precisely because "LF scrolls the viewport"). Search, mouse-scroll, and copy over
history work for free.
Evidence: `ink/log-update.ts:403-412,543-560,612-616`, `ink/renderer.ts:84-97`.
**TeXRA:** Already aligned in spirit — TeXRA appends finalized history once to native
scrollback via Ink `<Static>` and keeps a separate bottom live region
(`StaticConversationTranscript.tsx:1,138-143,208-219`; `App.tsx:258-273,772-781`). TeXRA
achieves the same ownership boundary _through_ stock Ink Static rather than a custom LF-scroll
buffer. Same outcome, less machinery; not a gap.

**Enforce the committed/live boundary by making out-of-viewport edits a hard error → full repaint.**
The diff classifies rows as reachable vs. scrolled-into-scrollback; any changed cell with
`y < viewportY` sets `needsFullReset` and bails to `fullResetSequence_CAUSES_FLICKER`
(carrying `triggerY/prevLine/nextLine` for attribution), because cursor-relative codes
physically cannot reach scrolled-away rows.
Evidence: `ink/log-update.ts:221-248,285-301,345-349,382-388,503-513`, `ink/frame.ts:73-83`.
**TeXRA:** Conceptually covered — TeXRA's "known-origin" repaint rule in `CLAUDE.md` and its
full-repaint patch already treat the committed/live seam as sacred. TeXRA doesn't need the
explicit per-cell invariant check because it doesn't run a cell-level diff; Ink owns that.
Learnable only if TeXRA ever moves off stock Ink diffing.

**Never reprint finalized content: blit unchanged React subtrees from the previous frame.**
A clean node whose cached Yoga rect is unchanged does `output.blit(prevScreen, ...)` — a
typed-array memcpy of last frame's pixels — and skips its subtree entirely. Contamination
guards (`prevFrameContaminated`) force a clean re-render when the prior buffer is untrustworthy.
Evidence: `ink/render-node-to-output.ts:452-481`, `ink/screen.ts:858-895`, `ink/renderer.ts:35-47,118-135`.
**TeXRA:** Partial gap, but largely neutralized. TeXRA prints finalized turns exactly once via
Static (so they aren't re-rendered each frame at all), and caches finalized ANSI markdown in
an LRU keyed by content (`render/ansiMarkdown.ts:409-459`; `TranscriptEntry.tsx:277-322,405-424`).
The blit fast-path is the same idea applied to a custom buffer TeXRA doesn't have. Not worth
adopting unless TeXRA replaces Ink's renderer.

**Diff at the cell level over a packed buffer, bounded to a damage rectangle.**
The `Screen` stores cells as 2 Int32s each in one contiguous array; writes union a `damage`
Rectangle; `diffEach` scans only that rect and `findNextDiff` skips identical runs by raw int
compare; style transitions are cached by `(fromId,toId)`. Near-zero GC, work proportional to change.
Evidence: `ink/screen.ts:355-383,1156-1206,1213-1224,112-162`, `ink/log-update.ts:302-381`.
**TeXRA:** Gap by design — TeXRA relies on Ink's line/string diff and caps re-wrap cost with
`LIVE_TAIL_ROWS=24` via `tailWindow` (`TranscriptEntry.tsx:277-322`). High effort, low
marginal value given the tail cap already bounds per-frame work. Do not prioritize.

**Maintain a virtual cursor and emit only relative moves, gated on whether the cell was actually written.**
`log-update` assumes it never knows the absolute cursor; a file-private `VirtualScreen.txn()`
emits patches and advances `(dx,dy)`; `writeCellWithStyleStr` refuses wide chars across the
viewport edge and returns `false`, and callers gate their style-state update on that return so
prediction never desyncs. Emoji width gets CHA fixups.
Evidence: `ink/log-update.ts:187-189,638-691,693-721,752-773`.
**TeXRA:** Inherits this from upstream Ink rather than owning it. Not a gap unless TeXRA forks
the cursor engine.

**Double-buffered frames with reusable pools and a self-healing alt-screen anchor.**
Front/back frame buffers swap and reuse; intern pools persist (periodically reset). In
alt-screen, every frame prepends CSI H and diffs against a `(0,0)` anchor so out-of-band
cursor perturbation (tmux status bar, Cmd+K) self-heals — which main-screen _cannot_ do,
explaining the heavy investment in boundary correctness there.
Evidence: `ink/ink.tsx:440-448,578-603,624-651`, `ink/renderer.ts:35-37`, `ink/render-to-screen.ts:34-43`.
**TeXRA:** N/A at this depth — TeXRA defaults to scrollback (no alt screen for the main REPL)
and uses Ink's buffering. The relevant takeaway (scrollback mode can't self-heal, so boundary
correctness matters) is already encoded in TeXRA's full-repaint discipline.

---

## 2. Resize & Reflow

**Force a full repaint on width change instead of trying to reflow-diff — and name the function after its cost.**
`render()` compares prev/next viewport and, on any width change (or height shrink), returns
`fullResetSequence_CAUSES_FLICKER` (clearTerminal + fresh full frame) rather than an
incremental diff, because soft-wrap reflow geometry is owned by the emulator and unobservable
from a write-only stdout. The provocative name prevents someone "optimizing" the flicker away.
Evidence: `ink/log-update.ts:136-147,503-513`, `ink/frame.ts:105-124`.
**TeXRA:** Already does exactly this — the vendored patch swaps count-based erase for a
debounced full repaint (`clearTerminal` then reprint reflowed `fullStaticOutput`), and
`CLAUDE.md` explicitly forbids reverting to line-count erasing. Strong alignment. The patch
examined here as 7.1.0 is unchanged and now lives at
`patches/ink@7.1.1.patch:26-66,69-82,87-124`. The only borrowable nuance is naming/commenting
the cost in code so it stays.

**Handle SIGWINCH synchronously (no debounce) but dedupe same-dimension events.**
`handleResize` runs synchronously, early-returns on `(cols,rows)` equality, updates cached
dims, and calls `render()` directly — _not_ the throttled path. A long comment explains a
debounce opens a window where `stdout.columns` is new but cached dims are old, so any spinner
render in that window detects a width change, clears, then the debounce fires and clears again
= double flicker.
Evidence: `ink/ink.tsx:303-346,212-216`.
**TeXRA:** **Divergence worth examining.** TeXRA's patch _debounces_ the full repaint at 24ms
(`patches/ink@7.1.1.patch`). Claude Code's argument is that debouncing desyncs source-of-truth width
from rendered width and can double-flicker if any other render fires in the debounce window.
TeXRA's debounce may be safe _because_ it routes all repaints through one full-reset path (no
spinner can paint a half-resized frame if nothing else renders independently), but this is the
one place where TeXRA's documented design and Claude Code's diverge on rationale. Worth a
deliberate check that no independent render (spinner tick, clock) can land mid-debounce.

**Re-render React (not just repaint) so the layout engine recomputes wrapped layout from the new width.**
`handleResize` updates cached width then re-renders `<App>` with new column props; the commit
phase runs `onComputeLayout` → `setWidth` + `calculateLayout`, and `measureFunc` re-wraps text
leaves. It deliberately avoids the throttled path so layout settles before the frame is produced.
Evidence: `ink/ink.tsx:239-258,338-345`.
**TeXRA:** Aligned in effect — TeXRA recomputes soft-wrap from `useWindowSize()` columns every
render via `wrap-ansi` (`App.tsx:455`; `render/ansiWrap.ts:75-115`) and remounts Static on width
change (`StaticConversationTranscript.tsx:299-306`). Width is already a layout input. Not a gap.

**Define the visible-vs-scrollback seam (including the cursor-restore off-by-one) in ONE formula, reused everywhere.**
The boundary is co-derived identically in `log-update`
(`viewportY = screen.height - viewport.height + cursorRestoreScroll`), the renderer (alt-screen
`viewport.height = terminalRows + 1`), and `useTerminalViewport`. Each comments that divergence
by that one row causes a flicker feedback loop (an animation ticks on a row log-update treats
as scrollback → full reset every tick).
Evidence: `ink/log-update.ts:285-299`, `ink/renderer.ts:150-172`, `ink/hooks/use-terminal-viewport.ts:78-92`.
**TeXRA:** Mostly N/A — this off-by-one is intrinsic to Claude Code's custom LF-scroll diff.
TeXRA's Static-based model doesn't compute a cursor-restore seam, so there's no divergence risk
to centralize. Relevant only if TeXRA builds offscreen-aware animation (see §8) where a
viewport seam reappears.

**Wrap erase+repaint in synchronized output (DEC 2026 BSU/ESU); prepend erase to the diff instead of writing it eagerly.**
On alt-screen resize, `needsEraseBeforePaint` is set but `ERASE_SCREEN` is _not_ written
immediately (render can take ~80ms; erasing first blanks the screen that whole time). The erase
is prepended to the diff and the whole thing wrapped in BSU/ESU so the user only ever sees old
or new, never blank. Hardware scroll (DECSTBM) is skipped when atomicity isn't available.
Evidence: `ink/ink.tsx:320-336,636-651`, `ink/terminal.ts:200-247`, `ink/log-update.ts:157-185`.
**TeXRA:** **Learnable opportunity.** TeXRA's repaint is `clearTerminal` then reprint, not
wrapped in synchronized-output markers. On slow reprints this can flash blank. If TeXRA's
full-repaint shows any visible blank gap on resize, wrapping the clear+reprint in DEC 2026
BSU/ESU (capability-gated — TeXRA already probes DECRQM 2027 in `terminalCapabilities.ts`)
would make it atomic. Low effort, directly leverages an existing capability probe.

**Give context values/callbacks stable identity so SIGWINCH doesn't re-fire teardown/setup effects.**
`writeRaw` is a bound method (not an inline arrow) so `TerminalWriteContext` keeps stable
identity across the render every resize triggers — an inline arrow would cascade through
`useContext` into `AlternateScreen`'s effect deps and cause a spurious alt-screen exit+re-enter
per drag tick.
Evidence: `ink/ink.tsx:1429-1435,59-66,316-318`.
**TeXRA:** General React hygiene; verify TeXRA's resize-triggered re-renders don't pass fresh
callback/array identities into effect dep arrays. Low-cost audit, not a confirmed gap.

---

## 3. Terminal Capability Negotiation & Feature Gating

**Terminate every capability-probe batch with a DA1 (CSI c) sentinel; resolve unanswered queries to "unsupported" — no timeouts.**
Because every VT100+ terminal answers DA1 and replies are FIFO-ordered, a query either gets its
reply before DA1 (supported) or DA1 arrives first (unsupported → `undefined`). `send()` never
rejects or sets a timer; an interleaved query/sentinel queue isolates concurrent probe batches.
Evidence: `ink/terminal-querier.ts:1-21,117-175,177-212`.
**TeXRA:** **Already adopted directly from this source** — TeXRA's DA1-sentinel discovery
batches Kitty keyboard, DECRQM 2027/2004, OSC4 then CSI c, treating replies-before-DA1 as
supported (`terminalCapabilities.ts:1-15,46-75,91-143`). One difference: TeXRA keeps a 250ms
safeguard timeout where Claude Code is strictly timeout-free. The safeguard is defensible
(guards against a terminal that somehow drops DA1), but the lesson is that the sentinel alone is
meant to _replace_ the timeout.

**Demux capability replies from keystrokes by syntactic distinguishability (and pick un-typeable probe forms).**
Responses (`CSI ? ... c`, `CSI ? ... $ y`) use patterns no physical key can produce; one parser
routes them off the key path. They chose DECXCPR (`CSI ?6n`) over plain DSR specifically because
plain DSR's reply collides with modified-F3 key sequences.
Evidence: `ink/parse-keypress.ts:96-122`, `ink/terminal-querier.ts:83-92`, `ink/components/App.tsx:455-460`.
**TeXRA:** Implicitly handled by running the probe _before_ Ink mounts
(`runChatTui.tsx:373-378`), sidestepping the shared-stdin demux problem entirely.
That's a simpler, equally-safe approach for one-shot startup detection. No gap.

**Two-tier detection: fast env heuristics plus an SSH-surviving in-band XTVERSION probe.**
Env vars are instant but break over SSH (`TERM_PROGRAM` isn't forwarded); an async XTVERSION
query (`CSI >0q`) travels through the pty and identifies the _client_ terminal. Readers treat
`undefined` as "fall back to env"; `setXtversionName()` is write-once.
Evidence: `ink/terminal.ts:120-146`, `ink/components/App.tsx:245-262`, `ink/supports-hyperlinks.ts:26-57`.
**TeXRA:** Partial — TeXRA does in-band DA1-batch probing (SSH-safe) but the evidence doesn't
show an XTVERSION client-identification layer. **Minor opportunity** if TeXRA needs per-terminal
behavior (not just per-capability), e.g. allowlisting specific terminals. Lower priority since
the capability probes already answer the questions that matter.

**Gate aggressiveness by failure mode: emit silently-discarded sequences unconditionally, allowlist garbage-producers.**
Sequences unsupported terminals ignore (tab status, title, alt/mouse _disables_ on exit) are
emitted unconditionally; sequences that corrupt input on unsupported terminals (Kitty keyboard,
modifyOtherKeys) are allowlist-gated. They note enabling Kitty unconditionally once regressed
(#23350).
Evidence: `ink/terminal.ts:148-169`, `ink/termio/osc.ts:458-469`, `ink/components/App.tsx:236-244`, `ink/terminal.ts:25-64`.
**TeXRA:** **Already aligned** — TeXRA gates Kitty keyboard and OSC 9/99 (vs. unconditional BEL)
on capability, while disables go out unconditionally on cleanup (`terminalCapabilities.ts`;
`terminalNotifier.ts:38-48`; `terminalCleanup.ts:3-9`). The failure-mode-driven gating principle
is present. The borrowable refinement is the explicit allowlist-of-known-good-terminals as a
second guard for Kitty, since DA1-probe support and _correct_ implementation aren't identical.

**Symmetric, idempotent, unconditional mode teardown across every exit path; pop-before-push for stacked modes.**
Every mode enabled on raw-mode entry is disabled in matching pairs on clean unmount, signal-exit
(synchronous `writeSync` because React unmount won't run), Ctrl-Z suspend/resume, and
external-editor handoff. Disables are unconditional (no-ops where unsupported). Kitty uses
DISABLE+ENABLE so re-asserts don't grow stack depth.
Evidence: `ink/components/App.tsx:232-279,390-438`, `ink/ink.tsx:1472-1505,357-419,896-918`.
**TeXRA:** **Partial — real opportunity.** TeXRA's signal exits already run synchronous
`writeSync` cleanup for mouse, kitty, bracketed paste, and cursor state before async drains
(`runChatTui.tsx:819-838,918-920`; `terminalCleanup.ts:44-54`). The remaining gaps are narrower:
no force-exit failsafe timer if shutdown persistence hangs, and no broader suspend/resume +
editor-handoff symmetry. See §9 for the failsafe gap.

**Route OSC features through a tmux/screen DCS-passthrough wrapper, with curated per-sequence exceptions.**
`wrapForMultiplexer()` tunnels escapes through tmux/screen DCS, but BEL is sent raw (wrapping
hides it from tmux's bell-action) and DEC 2026 sync output is skipped entirely under tmux (tmux
already breaks atomicity by chunking → 16 wasted bytes/frame).
Evidence: `ink/termio/osc.ts:23-44`, `ink/useTerminalNotification.ts:65-69`, `ink/terminal.ts:70-74`.
**TeXRA:** **Learnable gap.** No evidence of multiplexer DCS-passthrough in TeXRA. If TeXRA emits
OSC notifications/clipboard inside tmux, they may be eaten. Medium value if tmux users are
common; the per-sequence exceptions (raw BEL, skip sync-output) are the subtle part to copy verbatim.

**Hold capability-derived state in a module-level external store with a benign "unknown = best case" default, bridged via `useSyncExternalStore`.**
Focus state (DECSET 1004) lives in a module signal defaulting to `unknown`, which consumers
treat identically to `focused` (so focus-unaware terminals never get throttled); React reads it
via `useSyncExternalStore`, non-React code reads it directly; all raw writes funnel through one
`TerminalWriteContext`.
Evidence: `ink/terminal-focus-state.ts:1-47`, `ink/components/TerminalFocusContext.tsx:26-34`, `ink/hooks/use-terminal-title.ts:17-31`, `ink/useTerminalNotification.ts:6-31`.
**TeXRA:** TeXRA already uses lit-labs signals read via `useSignal` for shared state
(`useSignal.ts:1-29`; `cliState.ts:116-166`) — the external-store-not-Context pattern is present.
The specific borrowable is the "unknown-equals-best-case default" for any capability-derived
state so unsupported terminals degrade to full behavior, not throttled.

---

## 4. Input & Keyboard

**Separate a streaming boundary tokenizer from a stateless sequence interpreter.**
A VT500-style state machine (`createTokenizer`) only finds escape-sequence boundaries and
buffers an incomplete tail across `feed()` calls; `parseKeypress` is a pure function
interpreting one complete sequence. Boundary detection and key semantics never mix — making
partial-sequence handling correct-by-construction.
Evidence: `ink/termio/tokenize.ts:99-319`, `ink/parse-keypress.ts:213-302,611-785`.
**TeXRA:** Uses Ink's `useInput` + `usePaste` and custom key parsing (`inputKeys.ts:129-231`;
`BaseTextInput.tsx:392-500`) rather than a forked tokenizer. For TeXRA's scope (one App-level
handler, bracketed paste as one string) this is adequate; the streaming tokenizer matters most
for a fully-owned input stack. Not a priority gap.

**Normalize every keyboard protocol through one modifier bitmask, keeping super/cmd distinct from meta.**
Kitty CSI u, modifyOtherKeys, legacy tables, and raw control bytes collapse into
`{ctrl,meta,shift,option,super}` via one `decodeModifier`; `super` is its own bit (only Kitty
CSI u can express it) so a `cmd+c` binding is representable and simply never fires elsewhere
instead of colliding with alt.
Evidence: `ink/parse-keypress.ts:456-541,630-673`, `keybindings/match.ts:60-105`, `keybindings/resolver.ts:107-118`.
**TeXRA:** TeXRA rewrites Kitty Enter via an App effect (`App.tsx:628-640`) — a
targeted normalization rather than a general one-bitmask model. Adequate for its current binding
set; the general model is worth borrowing only if TeXRA grows configurable/chorded bindings.

**Layer a config-driven binding/chord resolver over `useInput`, with fall-through return values and a stable listener slot.**
A pure `resolveKeyWithChordState` returns tagged results (match/chord*started/.../none), prefers
longer chord prefixes, cancels on Escape; handlers returning `false` keep the event propagating;
`useInput` registers its listener \_once on mount* (not in the `isActive` dep) so its slot stays
stable and `stopImmediatePropagation` ordering survives toggles.
Evidence: `keybindings/resolver.ts:166-244`, `keybindings/useKeybinding.ts:33-97,113-196`, `ink/hooks/use-input.ts:50-90`.
**TeXRA:** TeXRA uses a single App-level `useInput` and Ink's broadcast-to-all-handlers model
(`App.tsx:498-511,694-770`). With one handler the stable-slot/propagation-ordering bug doesn't
bite. The borrowable lesson — register input listeners once, not keyed on `isActive` — is cheap
insurance if TeXRA ever adds multiple competing handlers.

**Model vim/modal input as a pure typed reducer with effects injected via a context.**
`VimState` is a discriminated union (the types are the docs); `transition(state,input,ctx)` is a
pure reducer returning `{next?,execute?}` that never touches React; `useVimInput` is the thin
adapter. Dot-repeat is a replay of a recorded change.
Evidence: `vim/types.ts:1-19,54-119`, `vim/transitions.ts:51-88`, `hooks/useVimInput.ts:175-295`.
**TeXRA:** Not applicable unless TeXRA adds modal editing. Noted for completeness only.

---

## 5. Reconciler & Render Performance

These practices presuppose Claude Code's forked render core. TeXRA runs on stock Ink with a
tail-window cap, so most are gaps-by-design rather than oversights.

**Guard every host-node setter with a value-equality check before marking dirty.**
`setAttribute`/`setTextNodeValue` bail on `===`; `setStyle`/`setTextStyles` do `shallowEqual`;
`children`/event-handlers are excluded from dirty tracking — neutralizing React 19's
new-object-per-render so unchanged subtrees stay clean and skip re-layout.
Evidence: `ink/dom.ts:247-289,393-413,51-52`, `ink/reconciler.ts:426-459`.
**TeXRA:** Inherited from Ink. Gap only if forking the reconciler.

**Throttle paints from the reconciler's commit callback through a leading+trailing throttle at a fixed frame interval, deferred one microtask.**
`scheduleRender` wraps `onRender` in a `throttle(..., 16ms)` whose body does
`queueMicrotask(onRender)`, fired from `resetAfterCommit`, so a burst of commits coalesces into
one ~60fps frame and the microtask defer ensures layout effects commit first (cursor doesn't lag
a keystroke).
Evidence: `ink/ink.tsx:203-216,237-238`, `ink/constants.ts:1-2`, `ink/reconciler.ts:303-315`.
**TeXRA:** Inherited from Ink's scheduler; TeXRA additionally avoids unnecessary ticks
(`useLiveNowMs.ts:1-14` ticks 1s only when needed; `appendStaticTranscriptItems` returns the
same array ref when nothing appended — `StaticConversationTranscript.tsx:220-222`). TeXRA's
instinct here is correct.

**Peephole-optimize the patch stream before writing (merge cursor moves, dedupe hyperlinks, cancel hide/show).**
A single linear pass over the diff drops no-ops, sums adjacent relative moves, concats adjacent
style strings, dedupes hyperlinks, cancels hide/show pairs — with documented "do NOT drop" cases
(style patches are transition diffs whose undo codes aren't a guaranteed subset).
Evidence: `ink/optimizer.ts:16-93,58-66`.
**TeXRA:** Inherited from Ink's output layer. Gap only if forking output.

Other engine practices — **per-node layout cache + blit** (`render-node-to-output.ts:452-482`),
**packed Screen + damage rect** (`screen.ts:355-383`), **memoized text pipeline**
(`output.ts:178-205,633-651`), **interned styles/hyperlinks** (`screen.ts:112-162`),
**layoutShifted narrow-vs-full flag** (`render-node-to-output.ts:27-41`),
**squash/raw-ansi pre-render** (`squash-text-nodes.ts:18-63`, `dom.ts:376-387`) — are all part
of the same custom render core. **TeXRA:** none adopted; the `LIVE_TAIL_ROWS=24` cap and
content-keyed ANSI LRU (`render/ansiMarkdown.ts:409-459`) achieve "cheap enough" without them.
Recommendation: do **not** chase these unless profiling shows the tail-window cap is insufficient.

---

## 6. Text, Unicode & ANSI

**Make terminal display width — not `String.length` — the single unit of truth, threaded through measure/wrap/slice/truncate/place.**
Every layer advances by `stringWidth` (ANSI=0, full-width=2); `sliceAnsi` advances `position` by
display width with a comment that `.length` over combining marks "advanced position past end
early and truncated the slice"; the cell writer places a `SpacerHead` blank when a width-2 char
can't fit the last column so the terminal's own wrap doesn't desync the cursor.
Evidence: `ink/wrap-text.ts:10-13,23-37`, `utils/sliceAnsi.ts:43-58`, `ink/output.ts:759-794`, `ink/render-border.ts:42-46`.
**TeXRA:** **Aligned** — TeXRA wraps via `wrap-ansi` and treats wide chars as 2 cells through
`string-width` (`render/ansiWrap.ts:75-115`; `render/terminalText.ts:1-28`), with grapheme-aware text input
(`BaseTextInput.tsx:122-180`). Width-as-unit is in place. The spacer-head edge case is owned by
`wrap-ansi`/Ink; not a gap.

**Layer width computation behind cheap pre-scans; prefer a native primitive resolved once at module scope.**
`stringWidth` tries `Bun.stringWidth` (resolved once to avoid deopting a 100k-calls/frame hot
path), then ASCII fast path, then a simple-Unicode loop (`eastAsianWidth` with
`ambiguousAsWide:false` — fixes ⚠ mis-measured as width 2), and only pays for `Intl.Segmenter`
when `needsSegmentation()`.
Evidence: `ink/stringWidth.ts:20-90,92-127,129-203,211-222`.
**TeXRA:** Uses `string-width` directly; layered fast-pathing is the library's concern. The
borrowable nuance is the `ambiguous=narrow` choice if TeXRA ever sees mis-measured symbols, but
no evidence of a problem. Low priority.

**Preserve ANSI across wraps/slices by tokenizing, not regex-stripping; reopen/close SGR per segment; handle OSC 8.**
`sliceAnsi` emits active start-codes at the slice start and an explicit undo sequence at the end
so each slice carries complete SGR open/close, and handles OSC 8 hyperlinks that `slice-ansi`
mishandles.
Evidence: `utils/sliceAnsi.ts:26-91`, `ink/output.ts:553-620`, `ink/Ansi.tsx:118-153`.
**TeXRA:** TeXRA uses `wrap-ansi` (which tokenizes/re-emits SGR) plus a markdown-prefix path
preserving quote gutters and list indents (`render/ansiWrap.ts:75-115`). Aligned in approach. Verify
OSC 8 hyperlink survival if TeXRA emits links in transcript markdown.

**Store colors as raw typed values; resolve depth quirks (xterm.js/tmux) once at startup via the color library's level, with an env escape hatch.**
At module load: boost chalk level 2→3 under `TERM_PROGRAM=vscode` (else Claude orange degrades to
salmon) and clamp 3→2 under `$TMUX` (else truecolor bg → black-on-dark), order chosen so the tmux
clamp can re-clamp a VS Code+tmux nesting, with an env override.
Evidence: `ink/styles.ts:36-53`, `ink/colorize.ts:176-220,20-26,47-62`.
**TeXRA:** **Learnable opportunity.** TeXRA strips SGR when color is off
(`render/noColorOutput.ts:71-105`) but the evidence doesn't show terminal-specific color-_depth_
adjustment for the VS Code-integrated-terminal or tmux truecolor-degradation cases. If TeXRA
renders in the VS Code integrated terminal or under tmux and colors look wrong, a one-time
chalk-level boost/clamp is a small, high-clarity fix. Medium priority, contingent on whether the
symptom exists.

**Cache per-immutable-line width, measure width+height in one allocation-free pass, gate bidi behind capability + content checks.**
`measureText` is one `indexOf`-based pass; `lineWidth` memoizes `stringWidth` per finalized line
(4096-entry, ~50x fewer calls); `reorderBidi` is gated three ways (only on terminals lacking
native bidi, only when `needsBidi()`, only when a cheap RTL regex confirms RTL content).
Evidence: `ink/measure-text.ts:11-45`, `ink/line-width-cache.ts:3-24`, `ink/bidi.ts:29-37,53-105`, `ink/tabstops.ts:9-46`.
**TeXRA:** Per-immutable-line caching is conceptually mirrored by TeXRA's content-keyed ANSI
markdown LRU. Bidi isn't in evidence either way; if TeXRA never needs RTL this is moot. Not a
priority.

---

## 7. Selection & Mouse

Claude Code builds a full app-owned selection/search/copy system over the Screen buffer (SGR
mouse parsing, anchor/focus state machine, solid-bg highlight, OSC 52 copy, drag-to-scroll with
off-screen accumulators). TeXRA makes a **deliberate, documented opposite choice.**

**Take over mouse selection only inside an alt-screen; outside it, let the terminal own selection/scroll/search/copy.**
Claude Code gates mouse tracking and selection to alt-screen only; native scrollback, search, and
mouse-wheel of finalized history are left to the emulator — a clear ownership boundary.
Evidence: `ink/components/AlternateScreen.tsx:14-59`, `ink/termio/dec.ts:47-60`, `ink/hit-test.ts:6-89`.
**TeXRA:** **Already on the simpler, correct side of this boundary by design.** TeXRA does no
mouse tracking, no SGR-mouse, no selection capture, no reimplemented scrollback/search — the
terminal owns all of it for finalized history, and in-app copy exists only inside modals
(`terminalCleanup.ts:3-9`; `ConversationPane.tsx:1-2`; `ExternalInquiry.tsx:66-99`). This matches
`CLAUDE.md`'s "don't reinvent the wheel" rule. **TeXRA does not need any of §7's selection
machinery** because it never takes over the main-buffer viewport. The only relevant Claude Code
lesson TeXRA already honors: keep selection out of the default scrollback flow.

(The remaining §7 practices — solid-bg over SGR-7 inverse, `noSelect`/`softWrap` buffer metadata,
code-unit→cell maps, lost-release recovery, OSC 52 copy-on-select — are all consequences of
_owning_ selection, which TeXRA intentionally doesn't. Listed here only to record that they were
verified and deliberately N/A for TeXRA.)

---

## 8. Component & Hook Discipline

**Back all animations/intervals with one shared Clock; gate the timer on whether any subscriber needs it and slow it when the terminal is blurred.**
One `ClockProvider` holds a subscriber Map; spinner/blink/shimmer/poller all subscribe; a single
`setInterval` ticks all with a snapshotted time (phase-synced), runs only while a `keepAlive`
subscriber exists, and slows to `FRAME_INTERVAL_MS*2` when blurred.
Evidence: `ink/components/ClockContext.tsx:10-68,70-108`, `ink/hooks/use-interval.ts:13-67`, `ink/hooks/use-animation-frame.ts:30-57`.
**TeXRA:** **High-value opportunity.** TeXRA already minimizes one timer (`useLiveNowMs` ticks 1s
only when needed), but the evidence doesn't show a single shared clock consolidating _all_
animated components. If TeXRA has multiple spinners/animations on independent intervals, a shared
clock yields one wake-up, phase-synced frames, and idle-when-nothing-ticks — directly serving
battery/CPU and the "live region minimal" discipline in `CLAUDE.md`. Medium effort, clear payoff.

**Offscreen-aware animation: pause ticks for elements scrolled out of the viewport, writing only a ref (never setState).**
`useAnimationFrame` pairs the clock with `useTerminalViewport`, which walks the DOM ancestor chain
each layout pass (accounting for `scrollTop` and the cursor-restore offset) and writes _only a
ref_ to decide visibility; when offscreen (or passed `null` for a stalled spinner) it
unsubscribes from the clock. Ref-only avoids infinite layout-effect loops.
Evidence: `ink/hooks/use-terminal-viewport.ts:46-93`, `ink/hooks/use-animation-frame.ts:34-54`, `components/Spinner/useShimmerAnimation.ts:11-17`.
**TeXRA:** **Learnable opportunity, tied to the Clock above.** TeXRA caps the live tail to 24
rows, so most animations are in-view by construction — but an animation on a row that has
scrolled into native scrollback both wastes work and (per TeXRA's own resize lore) can force
flicker. Worth adopting _if_ TeXRA adopts the shared Clock; the ref-only visibility write is the
subtle correctness detail.

**Keep app state in a tiny subscribe/getState store read via per-slice `useSyncExternalStore` selectors; stable Context value; stable setter.**
`AppState` is a plain store with `Object.is` bailout, created once via `useState` so the Context
value never re-renders consumers; components read slices via `useAppState(selector)`; write-only
components use the stable setter and never re-render. Selectors must return existing references.
Evidence: `state/store.ts:10-34`, `state/AppState.tsx:37-110,126-172`.
**TeXRA:** **Aligned** — TeXRA holds shared state in lit-labs signals read via `useSignal`, with
view toggles (form, palette, reverse search, viewer, focus) as signals not local state
(`useSignal.ts:1-29`; `cliState.ts:116-166`). Same fine-grained-subscription, no-Context-churn
outcome via a different primitive. Not a gap.

**Single-owner keyboard input: real `stopImmediatePropagation`, stable listener slots, context+isActive ownership.**
A custom EventEmitter stops the moment a handler calls `stopImmediatePropagation`; `useInput`
registers once with a stable slot; `useKeybinding` resolves against a prioritized context list so
a specific mode consumes the key before Global.
Evidence: `ink/hooks/use-input.ts:42-90`, `ink/events/emitter.ts:15-38`, `ink/events/event.ts:1-11`, `keybindings/useKeybinding.ts:33-90`, `hooks/useHistorySearch.ts:238-282`.
**TeXRA:** TeXRA's single App-level `useInput` over Ink's broadcast model sidesteps the
multi-handler racing problem by having essentially one owner that branches internally
(`App.tsx:498-511,694-770`). Adequate today; the registry pattern is the upgrade path if input
ownership ever fragments across components.

**Layered error boundaries: top-level overview + cheap per-item render-null isolation.**
A top-level class boundary renders an `ErrorOverview` and exits on fatal; inside the transcript,
each tool/progress render is wrapped in a minimal boundary that renders `null` (and surrounding
helpers `try/catch` → log → `return null`), so one bad message degrades to blank instead of
blanking the session.
Evidence: `components/SentryErrorBoundary.ts:11-28`, `ink/components/App.tsx:103-110,206-208`, `components/messages/AssistantToolUseMessage.tsx:341-358`.
**TeXRA:** **Already shipped.** `EntryErrorBoundary` now wraps live transcript entries and static
transcript entries, so a single malformed entry (bad markdown, a throwing tool renderer) degrades
that entry rather than blanking the whole TUI. This is no longer a borrowable gap; it is an adopted
practice to preserve.

**Thin composition-root + per-provider isolation with stable (`useState`-created) values.**
`App.tsx` is logic-free, only stacking providers; each provider (e.g. `ClockProvider`) is its own
component with a stable value so creating/changing one service doesn't re-render the whole tree.
Evidence: `components/App.tsx:19-55`, `ink/components/App.tsx:154-180`, `ink/components/ClockContext.tsx:72-108`.
**TeXRA:** **Aligned** — `App.tsx` is the single vertical column with pure exported layout
helpers and signal-based state (`App.tsx:441-461,630-686,772-846`). Same leaf-free-root
discipline. Not a gap.

**Bridge imperative one-off dialogs to React as Promise-returning launchers (render → `done()` resolves), lazily imported.**
`showSetupDialog(root, done => <Dialog onDone={done}/>)` returns a Promise resolved by the dialog;
each launcher dynamic-imports its component; setup flows just `await` them in sequence.
Evidence: `interactiveHelpers.tsx:40-44,86-103,104-170`, `dialogLaunchers.tsx:29-65`.
**TeXRA:** Pattern-level borrowable for any sequential modal flow (TeXRA has modals for
inquiries/copy). Low priority unless TeXRA builds multi-step setup/onboarding.

---

## 9. Headless Parity & Lifecycle

**Make headless a separate render/output path that never imports the TUI framework, decided by one predicate at startup.**
One `isNonInteractive` predicate (print flag OR not-a-TTY etc.) gates everything; when
non-interactive the Ink root is _never created_ and `runHeadless` writes plain text/JSON straight
to stdout from a module that imports zero React/Ink — so `patchConsole` (which would swallow
console output) never loads. Separation by construction, not by per-call-site guards.
Evidence: `main.tsx:799-815,2211-2229,2824-2860`, `utils/process.ts:17-34`.
**TeXRA:** **Already aligned and arguably cleaner** — `runChat` refuses to mount the TUI unless
stdin+stdout are TTYs and `TERM` isn't dumb, routing non-TTY/print/CI to `texra run` so Ink chrome
never leaks to piped output; gate keys off `mode headless`/`stdoutIsTty !== true`; SGR stripped
when color off; DA1 returns `NONE` off-TTY (`terminalRequirements.ts:5-8`;
`render/noColorOutput.ts:71-105`; `terminalCapabilities.ts:94-97`;
`cliContext.ts:130-132,269`). This matches `CLAUDE.md`'s "headless parity is sacred" rule. Strong
alignment, no gap.

**Default to appending to native scrollback; make the alternate screen an opt-in self-restoring component.**
The main REPL uses relative-cursor diffing into native scrollback; alt-screen is a scoped
`<AlternateScreen>` whose `useInsertionEffect` enters on mount and restores on unmount
(insertion-effect chosen so ENTER reaches the terminal before the first frame).
Evidence: `ink/components/AlternateScreen.tsx:13-32,44-67`, `ink/renderer.ts:146-176`, `ink/log-update.ts:186-196`.
**TeXRA:** **Aligned** — TeXRA's whole model is scrollback-by-default with no main-REPL alt screen
(the §1/§7 evidence). Same philosophy. Not a gap.

**Restore the terminal with synchronous `writeSync` + an unconditional batch of disable escapes, wired to ALL exit signals plus an orphan detector and a force-exit failsafe.**
On exit, `writeSync(1, …)` sends every disable unconditionally (alt-screen exit first, mouse,
kitty/modify, focus, bracketed paste, show cursor, clear progress/tab) because React's async
unmount may never run on signal exit. `gracefulShutdown` registers SIGINT/SIGTERM/SIGHUP + an
orphan detector (TTY revoked without SIGHUP), runs cleanup BEFORE async work, arms a failsafe
timer, and falls back to SIGKILL on EIO from a dead PTY.
Evidence: `ink/ink.tsx:1455-1533,921-955`, `utils/gracefulShutdown.ts:58-136,193-232,256-297,414-437`.
**TeXRA:** **Mostly aligned; one narrow gap remains.** TeXRA already runs synchronous
`cleanupTerminalModes()` before async shutdown on SIGINT/SIGTERM/SIGHUP
(`runChatTui.tsx:819-838,918-920`; `terminalCleanup.ts:44-54`), so the classic signal-exit
terminal-mode footgun is covered. The borrowable gap is the force-exit failsafe: if
`drainPersistence()` or platform shutdown hangs after terminal modes are restored, TeXRA currently
has no last-resort timer. An orphan-detector path may also be useful if the controlling TTY is
revoked without SIGHUP.

**Reference-count raw mode (and terminal-mode escapes) so nested consumers compose; snapshot/restore across suspend.**
`rawModeEnabledCount` emits enter sequences only on 0→1 and disables only on return to 0; suspend
snapshots the count, fully unwinds, then restores exactly that many on resume; entry is gated on
`stdin.isTTY`.
Evidence: `ink/components/App.tsx:114,151-153,221-265,269-280,390-422`.
**TeXRA:** **Learnable opportunity.** No evidence of raw-mode reference counting or Ctrl-Z
suspend/resume restoration in TeXRA. With a single App-level input handler this is lower-urgency
than signal teardown, but suspend/resume (Ctrl-Z then `fg`) correctness and safe composition of
any future modal that wants raw mode both depend on it. Medium priority.

**Stay interactive on piped stdin via a cached `/dev/tty` fallback; detect idle pipes; handle EPIPE.**
When `process.stdin` is piped but the user is at a terminal, `getStdinOverride()` opens `/dev/tty`
(cached once, skipped in CI/MCP/Windows) so the TUI still reads keystrokes; for headless ingestion
`peekForStdinData` warns after 3s on an idle inherited pipe; global EPIPE handling makes
`claude -p | head -1` not crash.
Evidence: `utils/renderOptions.ts:8-60,62-77`, `main.tsx:857-883`, `utils/process.ts:1-15,50-68`.
**TeXRA:** **Learnable opportunity.** TeXRA refuses the TUI when stdin isn't a TTY
(`terminalRequirements.ts:5-8`) — correct and safe, but it means a user at a real terminal whose
stdin was merely redirected (e.g. `texra < file` while wanting interaction) loses the TUI. The
`/dev/tty` fallback recovers interactivity in that case. Plus: ensure EPIPE is handled so
`texra ... | head` composes cleanly. Medium priority; the EPIPE/pipe-citizenship part is cheap and
aligns with `CLAUDE.md`'s clig.dev commitments.

**Key renderer instances by output stream (self-removing on unmount); offer a createRoot/render split.**
A `Map<WriteStream, Ink>` guarantees one renderer per stdout (no two instances fighting over
cursor/scrollback) and gives signal handlers a stable handle to the live instance; `createRoot`
separates instance creation from rendering so one root drives sequential screens.
Evidence: `ink/instances.ts:1-10`, `ink/root.ts:172-184,90-105,125-157`, `utils/gracefulShutdown.ts:86-98,209`.
**TeXRA:** Mostly internal to a forked runtime; TeXRA mounts a single Ink root, so the
multi-instance hazard is unlikely. The borrowable nugget is giving signal/cleanup code a stable
handle to the live renderer — relevant if/when TeXRA adds the synchronous signal teardown above.

---

## Top Things Worth Adopting/Borrowing for TeXRA (highest leverage first)

1. **Force-exit failsafe after the already-synchronous terminal restoration.** TeXRA already
   runs `writeSync` cleanup on SIGINT/SIGTERM/SIGHUP (see Status / corrections above); the
   remaining borrowable piece is a last-resort timer if shutdown persistence hangs after modes
   have been restored. Low effort, narrow payoff.
   (`gracefulShutdown.ts:58-136,256-297,414-437`)
2. **A single shared animation Clock** (subscriber map + snapshotted time, idle when no subscriber,
   slow when blurred). Consolidates all spinners/animations into one phase-synced wake-up; serves
   battery/CPU and the "minimal live region" rule. (`ClockContext.tsx:10-108`)
3. **`/dev/tty` fallback for piped-but-interactive stdin, plus EPIPE handling.** Recovers the TUI
   when stdin is redirected at a real terminal, and makes `texra | head` a well-behaved pipeline
   citizen (aligns with TeXRA's clig.dev commitment). (`renderOptions.ts:8-60`; `process.ts:1-15`)
4. **Wrap the resize clear+reprint in DEC 2026 BSU/ESU (capability-gated, which TeXRA already
   probes).** Eliminates any visible blank flash during the full repaint by making erase+paint
   atomic. Low effort, leverages an existing probe. (`ink.tsx:636-651`; `terminal.ts:200-247`)
5. **Reference-count raw mode + snapshot/restore across Ctrl-Z suspend.** Makes future modals
   safely compose raw mode and fixes suspend/resume terminal state. Medium priority.
   (`App.tsx:114,221-280,390-422`)
6. **Offscreen-aware animation pausing (ref-only visibility, unsubscribe when scrolled into
   scrollback).** Adopt alongside the shared Clock; avoids wasted ticks and a flicker source on
   rows that scrolled out. (`use-terminal-viewport.ts:46-93`; `use-animation-frame.ts:34-54`)
7. **One-time chalk-level boost/clamp for VS Code-integrated-terminal and tmux truecolor
   degradation, with an env escape hatch** — _if_ TeXRA exhibits the salmon/black-on-dark color
   symptom. Small, well-scoped fix. (`colorize.ts:20-62`)
8. **tmux/screen DCS-passthrough wrapper with per-sequence exceptions (raw BEL, skip sync-output
   under tmux)** — _if_ TeXRA emits OSC notifications/clipboard and tmux users matter.
   (`osc.ts:23-44`; `terminal.ts:70-74`)

**Deliberately not recommended:** the custom packed-Screen render core (blit, cell diff, intern
pools, peephole optimizer) and the app-owned mouse-selection/search stack. TeXRA's
`LIVE_TAIL_ROWS` cap + content-keyed ANSI LRU already make rendering "cheap enough," and TeXRA's
choice to leave selection/scroll/search to the terminal is the simpler, correct boundary that
`CLAUDE.md` already enshrines — adopting either would add large machinery against TeXRA's stated
design.

---

_All file:line citations in the "claude-code" columns are relative to the de-obfuscated Claude
Code source dump's `src/` (vendored Ink fork under `src/ink/`); TeXRA citations are relative to
this repo. Findings were extracted by parallel deep-reader agents and adversarially fact-checked
against the cited code._
