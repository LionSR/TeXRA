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
import { Effect } from 'effect';

import { getCodexStatus } from '@auth/codex';
import { isPreferCodexSubscription } from '@model/codex/codexPreference';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { ChatGptAuthStatus } from '@shared/schemas';

export function getChatGptAuthStatus(
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<ChatGptAuthStatus> {
  return Effect.map(getCodexStatus(secrets), (status) => ({
    ...status,
    preferSubscription: isPreferCodexSubscription(stores),
  }));
}
