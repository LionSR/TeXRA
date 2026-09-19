/**
 * Grok auth status as the settings views consume it: session status plus the
 * prefer-subscription switch.
 */
import { Effect } from 'effect';

import { getXaiStatus } from '@auth/xai';
import { isPreferXaiSubscription } from '@model/xai/xaiSubscription';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { GrokAuthStatus } from '@shared/schemas';

export function getGrokAuthStatus(
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<GrokAuthStatus> {
  return Effect.map(getXaiStatus(secrets), (status) => ({
    ...status,
    preferSubscription: isPreferXaiSubscription(stores),
  }));
}
