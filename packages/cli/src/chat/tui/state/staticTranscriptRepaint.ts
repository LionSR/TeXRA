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
