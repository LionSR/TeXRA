import {
  kimiCodeCoordinator,
  loginWithKimiCodeDeviceCode,
  setPreferKimiCodeSubscription,
  type KimiCodeSession,
  type KimiCodeSubscriptionPreferenceUpdate,
} from '@auth/kimiCode';
import { toErrorMessage } from '@utils/errors/errorMessage';

export interface CliKimiCodeLoginOptions {
  readonly writeProgress: (message: string) => void;
}

export type CliKimiCodeSignOutResult =
  | {
      readonly preferenceUpdate: KimiCodeSubscriptionPreferenceUpdate;
      readonly preferenceError?: undefined;
    }
  | {
      readonly preferenceUpdate?: undefined;
      readonly preferenceError: string;
    };

/**
 * Kimi Code offers only the device-code flow (no loopback), so the CLI login
 * is a single shape: print the verification URL + one-time code, then poll.
 */
export async function signInCliKimiCode(
  options: CliKimiCodeLoginOptions,
): Promise<KimiCodeSession> {
  return loginWithKimiCodeDeviceCode({
    coordinator: kimiCodeCoordinator(),
    onPrompt: ({ userCode, verificationUrl }) => {
      options.writeProgress(
        `To sign in with Kimi Code:\n  1. Open ${verificationUrl}\n  2. Confirm the one-time code: ${userCode}\nWaiting for approval... (Ctrl-C cancels)`,
      );
    },
  });
}

export function kimiCodeSignOutPreferenceMessage(
  result: CliKimiCodeSignOutResult,
): string {
  const update = result.preferenceUpdate;
  if (!update) {
    return `Kimi Code subscription preference could not be disabled: ${result.preferenceError}`;
  }
  return update.effective
    ? `Kimi Code subscription preference is still enabled because a more specific setting overrides ${update.target} config.`
    : 'Kimi Code subscription disabled.';
}

export async function signOutCliKimiCode(): Promise<CliKimiCodeSignOutResult> {
  await kimiCodeCoordinator().signOut();
  try {
    return { preferenceUpdate: await setPreferKimiCodeSubscription(false) };
  } catch (error: unknown) {
    return { preferenceError: toErrorMessage(error) };
  }
}
