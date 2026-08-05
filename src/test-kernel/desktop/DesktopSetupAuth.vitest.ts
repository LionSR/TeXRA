import { describe, expect, it, vi } from 'vitest';

import {
  initializeDesktopSetupAuth,
  registerDesktopSetupSignIn,
} from '@desktop/main/desktopSetupAuth';
import { getSetupPlatform } from '@tools/setup/platform';

describe('desktop setup auth adapter', () => {
  it('exposes the existing desktop sign-in capability to setup tools', async () => {
    const signIn = vi.fn(async () => true);
    initializeDesktopSetupAuth();
    registerDesktopSetupSignIn(signIn);

    expect(getSetupPlatform().host).toBe('desktop');
    await expect(getSetupPlatform().signIn()).resolves.toBe(true);
    expect(signIn).toHaveBeenCalledOnce();
  });

  it('does not retain a closed window sign-in capability', async () => {
    const signIn = vi.fn(async () => true);
    initializeDesktopSetupAuth();
    const windowRegistration = registerDesktopSetupSignIn(signIn);

    windowRegistration.dispose();

    await expect(getSetupPlatform().signIn()).resolves.toBe(false);
    expect(signIn).not.toHaveBeenCalled();
  });
});
