import { setSetupPlatform } from '@tools/setup/platform';

let activeSignIn: (() => Promise<boolean>) | undefined;

/** Install a process-owned setup adapter that resolves the active window lazily. */
export function initializeDesktopSetupAuth(): void {
  setSetupPlatform({
    host: 'desktop',
    signIn: () => activeSignIn?.() ?? Promise.resolve(false),
  });
}

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
