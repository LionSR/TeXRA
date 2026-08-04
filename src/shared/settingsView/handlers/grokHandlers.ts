/**
 * Grok-subscription auth status outbound message builder.
 */
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  GrokAuthStatus,
  UpdateGrokAuthStatusMessage,
} from '@shared/schemas/settingsViewMessages';

export async function buildGrokAuthStatusMessage(
  getStatus: () => Promise<GrokAuthStatus>,
): Promise<UpdateGrokAuthStatusMessage> {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_GROK_AUTH_STATUS,
    status: await getStatus(),
  };
}
