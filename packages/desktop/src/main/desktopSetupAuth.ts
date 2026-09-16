import { Effect } from 'effect';

import type { SignInFailed } from '@common/errors/signInFailed';
import type { SetupPlatformShape } from '@tools/setup/platform';

/** A window's sign-in flow, as the setup platform calls it. */
type DesktopSetupSignIn = () => Effect.Effect<boolean, SignInFailed>;

/**
 * The desktop's setup sign-in registration. The composition root
 * (`platform/index.ts`) creates one of these and installs its `platform` with
 * the process runtime before any window exists; each window then registers
 * its own sign-in flow, which needs the window to anchor its dialogs to, and
 * unregisters with the window's resources.
 */
export interface DesktopSetupAuth {
  /** The `SetupPlatform` service value the process runtime serves. */
  readonly platform: SetupPlatformShape;
  /** Register one window without retaining it after the returned handle closes. */
  registerSignIn(signIn: DesktopSetupSignIn): { dispose(): void };
}

export function createDesktopSetupAuth(): DesktopSetupAuth {
  let activeSignIn: DesktopSetupSignIn | undefined;
  return {
    platform: {
      host: 'desktop',
      signIn: () => activeSignIn?.() ?? Effect.succeed(false),
    },
    registerSignIn(signIn) {
      activeSignIn = signIn;
      return {
        dispose() {
          if (activeSignIn === signIn) activeSignIn = undefined;
        },
      };
    },
  };
}
