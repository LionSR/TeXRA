/**
 * The ChatGPT auth status as the settings views consume it: the session status
 * plus the current subscription preference. One composer so the extension and
 * desktop hosts post the identical payload (the wire shape is validated by
 * `ChatGptAuthStatusSchema` at each host's boundary).
 *
 * This was split from `@auth/codex/codexAuthAccess.ts` so the model layer can
 * read the subscription preferences (`@model/codex/codexPreference`) without
 * depending on the Codex OAuth machinery.
 */
import { getCodexStatus } from '@auth/codex';
import { isPreferCodexSubscription } from '@model/codex/codexPreference';
import type { ChatGptAuthStatus } from '@shared/schemas';

export async function getChatGptAuthStatus(): Promise<ChatGptAuthStatus> {
  return {
    ...(await getCodexStatus()),
    preferSubscription: isPreferCodexSubscription(),
  };
}
