/**
 * Grok auth status as the settings views consume it: session status plus the
 * prefer-subscription switch.
 */
import { runAuthProgram } from '@auth/authProgram';
import { getXaiStatus } from '@auth/xai';
import { isPreferXaiSubscription } from '@model/xai/xaiPreference';
import type { PlatformSecrets } from '@platform/secrets';
import type { GrokAuthStatus } from '@shared/schemas';

export async function getGrokAuthStatus(
  secrets: PlatformSecrets,
): Promise<GrokAuthStatus> {
  return {
    ...(await runAuthProgram(getXaiStatus(secrets))),
    preferSubscription: isPreferXaiSubscription(),
  };
}
