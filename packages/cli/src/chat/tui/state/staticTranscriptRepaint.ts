// One monotonically increasing epoch shared by the session-exit controller and
// the conversation region. A terminal resume (SIGCONT) bumps it so the static
// transcript's render key changes, remounting `<Static>` and routing through
// `onRenderKeyChange`'s replace-semantics repaint (clear scrollback +
// preserveStatic:false) instead of replaying Ink's accumulated
// `fullStaticOutput`.

import { signal } from '@lit-labs/signals';

export const staticTranscriptRepaintEpoch = signal(0);

export function invalidateStaticTranscriptForRepaint(): void {
  staticTranscriptRepaintEpoch.set(staticTranscriptRepaintEpoch.get() + 1);
}

// A second epoch for erases that happen outside Ink (`/clear` writes
// clear-screen-and-scrollback directly). Unlike a repaint invalidation, an
// erase must re-emit the transcript even when the rebuilt state matches the
// current items — the terminal no longer shows them — and the rebuild must
// happen in `advanceStaticTranscriptState`, after the reset state commits,
// so the remounted `<Static>` never carries stale rows.
export const staticTranscriptEraseEpoch = signal(0);

export function notifyStaticTranscriptErased(): void {
  staticTranscriptEraseEpoch.set(staticTranscriptEraseEpoch.get() + 1);
}
