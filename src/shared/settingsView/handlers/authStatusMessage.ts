/**
 * Auth-status outbound message builder, shared by ChatGPT- and Grok-subscription
 * providers.
 *
 * The status lookup itself is host-injected (extension and desktop both call
 * the same `@auth/*` helper, but this file can't import it directly — see
 * `SharedSettingsViewBoundary.vitest.ts`) so only the wire-message shape is
 * centralized here. Each provider passes its own command constant and status
 * getter; the object shape is identical across providers.
 */
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

export async function buildAuthStatusMessage<
  C extends
    (typeof SETTINGS_VIEW_COMMANDS)[keyof typeof SETTINGS_VIEW_COMMANDS],
  S,
>(command: C, getStatus: () => Promise<S>): Promise<{ command: C; status: S }> {
  return {
    command,
    status: await getStatus(),
  };
}
