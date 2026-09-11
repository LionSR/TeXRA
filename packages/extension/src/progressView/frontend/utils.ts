// Shared utility functions for the progress view frontend.

import type { RunId } from '@shared/schemas';
import { SessionUiEvents } from '@shared/session/uiEvents';

/**
 * Find the first matching element in a composed event path.
 */
export function getComposedPathElement<T extends Element>(
  event: Event,
  selector: string,
): T | null {
  const path = event.composedPath?.() ?? [];
  for (const entry of path) {
    if (entry instanceof Element && entry.matches(selector)) {
      return entry as T;
    }
  }
  return null;
}

/**
 * Dispatch a `<wa-details>` group's open/close as a surface action. Wired to
 * both `wa-show` and `wa-hide`, which BUBBLE (unlike the native `<details>`
 * `toggle`), so a nested group's toggle would otherwise re-trigger every
 * ancestor — hence the `target === currentTarget` guard. Direction comes from
 * the event type rather than local state, so no per-row closures are needed,
 * and the surface owns the answer: the group body follows the `expanded` map
 * the host hands back.
 */
export function dispatchGroupToggle(
  host: EventTarget,
  event: Event,
  runId: RunId | null,
  key: string,
): void {
  if (event.target !== event.currentTarget || runId === null) return;
  host.dispatchEvent(
    SessionUiEvents.surface({
      kind: 'group',
      runId,
      key,
      expanded: event.type === 'wa-show',
    }),
  );
}
