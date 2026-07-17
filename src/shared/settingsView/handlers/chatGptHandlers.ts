/**
 * ChatGPT-subscription auth status outbound message builder.
 *
 * The status lookup itself is host-injected (extension and desktop both call
 * the same `@auth/*` helper, but this file can't import it directly — see
 * `SharedSettingsViewBoundary.vitest.ts`) so only the wire-message shape is
 * centralized here.
 */
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  ChatGptAuthStatus,
  KimiCodeAuthStatus,
  UpdateChatGptAuthStatusMessage,
  UpdateKimiCodeAuthStatusMessage,
} from '@shared/schemas/settingsViewMessages';

export async function buildChatGptAuthStatusMessage(
  getStatus: () => Promise<ChatGptAuthStatus>,
): Promise<UpdateChatGptAuthStatusMessage> {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
    status: await getStatus(),
  };
}

export async function buildKimiCodeAuthStatusMessage(
  getStatus: () => Promise<KimiCodeAuthStatus>,
): Promise<UpdateKimiCodeAuthStatusMessage> {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_KIMI_CODE_AUTH_STATUS,
    status: await getStatus(),
  };
}
