import { SessionUiEvents } from '@ui/progress/uiEvents';
import { isOwnDetailsToggle } from '@ui/litControllers/detailsToggle';
import type { RunId } from '@texra-ai/harness/schemas';

/**
 * Dispatch a `<wa-details>` disclosure's open/close as a surface action. Wired to
 * both `wa-show` and `wa-hide`, which BUBBLE (unlike the native `<details>`
 * `toggle`), so a nested disclosure's toggle would otherwise re-trigger every
 * ancestor — hence the `target === currentTarget` guard. Direction comes from
 * the event type rather than local state, so no per-row closures are needed,
 * and the surface owns the answer: the disclosure's body follows the `expanded` map
 * the host hands back.
 */
export function dispatchDisclosureToggle(
  host: EventTarget,
  event: Event,
  runId: RunId | null,
  key: string,
): void {
  if (!isOwnDetailsToggle(event) || runId === null) return;
  host.dispatchEvent(
    SessionUiEvents.surface({
      kind: 'group',
      runId,
      key,
      expanded: event.type === 'wa-show',
    }),
  );
}
