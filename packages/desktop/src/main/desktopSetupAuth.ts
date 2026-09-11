import type { SetupPlatformShape } from '@tools/setup/platform';

let activeSignIn: (() => Promise<boolean>) | undefined;

/**
 * The desktop's setup capabilities, provided as the `SetupPlatform` service
 * by the composition root (`platform/index.ts`); sign-in resolves the active
 * window lazily, so the value exists before any window does.
 */
export const desktopSetupPlatform: SetupPlatformShape = {
  host: 'desktop',
  signIn: () => activeSignIn?.() ?? Promise.resolve(false),
};

/** Register one window without retaining it after the returned handle closes. */
export function registerDesktopSetupSignIn(signIn: () => Promise<boolean>): {
  dispose(): void;
} {
  activeSignIn = signIn;
  return {
    dispose() {
      if (activeSignIn === signIn) activeSignIn = undefined;
    },
  };
}
