import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_SETUP_MODEL,
  SETUP_MODEL_BY_PROVIDER,
} from '@model/setupModelDefaults';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';

/**
 * `resolveSetupModelExcludingOpenRouter` is the credential-priority core
 * shared by the VS Code extension (`resolveLaunchModel`) and desktop
 * (`resolveDesktopSetupModel`) setup-launch paths. Exercising it directly
 * guards the priority order (ChatGPT subscription > server-side default >
 * server-side per-provider > direct provider key) against silently
 * drifting between hosts again.
 */

const mocks = vi.hoisted(() => ({
  isCodexSubscriptionActive: vi.fn<() => Promise<boolean>>(),
  canUseServerSideKeys: vi.fn<() => Promise<boolean>>(),
  canUseServerSideKeysForModel: vi.fn<(model: string) => Promise<boolean>>(),
  canUseModelSync: vi.fn<(model: string) => boolean>(),
  lookupApiKey:
    vi.fn<
      (secrets: unknown, provider: string) => Promise<string | undefined>
    >(),
  getUseOpenRouter: vi.fn<() => boolean>(),
}));

vi.mock('@auth/codex', () => ({
  isCodexSubscriptionActive: mocks.isCodexSubscriptionActive,
}));

vi.mock('@auth/serverKeys', () => ({
  getServerSideKeyService: () => ({
    canUseServerSideKeys: mocks.canUseServerSideKeys,
    canUseServerSideKeysForModel: mocks.canUseServerSideKeysForModel,
    canUseModelSync: mocks.canUseModelSync,
  }),
}));

vi.mock('@model/apiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@model/apiProviders')>();
  return { ...actual, lookupApiKey: mocks.lookupApiKey };
});

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: {} }),
}));

vi.mock('@utils/config/providerConfig', () => ({
  getUseOpenRouter: mocks.getUseOpenRouter,
}));

const { resolveSetupModelExcludingOpenRouter, resolveDesktopSetupModel } =
  await import('@controllers/onboarding/setupLaunch');

describe('resolveSetupModelExcludingOpenRouter', () => {
  beforeEach(() => {
    mocks.isCodexSubscriptionActive.mockReset().mockResolvedValue(false);
    mocks.canUseServerSideKeys.mockReset().mockResolvedValue(false);
    mocks.canUseServerSideKeysForModel.mockReset().mockResolvedValue(false);
    mocks.canUseModelSync.mockReset().mockReturnValue(false);
    mocks.lookupApiKey.mockReset().mockResolvedValue(undefined);
    mocks.getUseOpenRouter.mockReset().mockReturnValue(false);
  });

  it('prefers an active ChatGPT subscription over every other credential', async () => {
    mocks.isCodexSubscriptionActive.mockResolvedValue(true);
    mocks.canUseServerSideKeysForModel.mockResolvedValue(true);
    mocks.lookupApiKey.mockResolvedValue('sk-test');

    await expect(
      resolveSetupModelExcludingOpenRouter({} as never),
    ).resolves.toBe(CHATGPT_SETUP_MODEL);
  });

  it('falls back to the default agent model when server-side keys cover it', async () => {
    mocks.canUseServerSideKeysForModel.mockResolvedValue(true);

    await expect(
      resolveSetupModelExcludingOpenRouter({} as never),
    ).resolves.toBe(DEFAULT_AGENT_MODEL);
    expect(mocks.canUseServerSideKeysForModel).toHaveBeenCalledWith(
      DEFAULT_AGENT_MODEL,
    );
  });

  it('scans per-provider setup models when the default is out of tier', async () => {
    mocks.canUseServerSideKeysForModel.mockResolvedValue(false);
    mocks.canUseServerSideKeys.mockResolvedValue(true);
    mocks.canUseModelSync.mockImplementation(
      (model) => model === SETUP_MODEL_BY_PROVIDER.google,
    );

    await expect(
      resolveSetupModelExcludingOpenRouter({} as never),
    ).resolves.toBe(SETUP_MODEL_BY_PROVIDER.google);
  });

  it('skips the openRouter entry when scanning per-provider server-side models', async () => {
    mocks.canUseServerSideKeys.mockResolvedValue(true);
    // Only the openRouter-mapped model would satisfy this — it must never
    // be picked here, since server-side keys route directly, not via OR.
    mocks.canUseModelSync.mockImplementation(
      (model) => model === SETUP_MODEL_BY_PROVIDER.openRouter,
    );

    await expect(
      resolveSetupModelExcludingOpenRouter({} as never),
    ).resolves.toBeNull();
  });

  it('falls back to a direct provider API key, skipping openRouter', async () => {
    mocks.lookupApiKey.mockImplementation(async (_secrets, provider) =>
      provider === 'anthropic' ? 'sk-ant-test' : undefined,
    );

    await expect(
      resolveSetupModelExcludingOpenRouter({} as never),
    ).resolves.toBe(SETUP_MODEL_BY_PROVIDER.anthropic);
    expect(mocks.lookupApiKey).not.toHaveBeenCalledWith(
      expect.anything(),
      'openRouter',
    );
  });

  it('returns null when no credential resolves to a runnable model', async () => {
    await expect(
      resolveSetupModelExcludingOpenRouter({} as never),
    ).resolves.toBeNull();
  });
});

describe('resolveDesktopSetupModel', () => {
  beforeEach(() => {
    mocks.isCodexSubscriptionActive.mockReset().mockResolvedValue(false);
    mocks.canUseServerSideKeys.mockReset().mockResolvedValue(false);
    mocks.canUseServerSideKeysForModel.mockReset().mockResolvedValue(false);
    mocks.canUseModelSync.mockReset().mockReturnValue(false);
    mocks.lookupApiKey.mockReset().mockResolvedValue(undefined);
    mocks.getUseOpenRouter.mockReset().mockReturnValue(false);
  });

  it('routes through OpenRouter only when the flag is on and a key exists', async () => {
    mocks.getUseOpenRouter.mockReturnValue(true);
    mocks.lookupApiKey.mockImplementation(async (_secrets, provider) =>
      provider === 'openRouter' ? 'or-test' : undefined,
    );

    await expect(resolveDesktopSetupModel()).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.openRouter,
    );
  });

  it('refuses launch when the OpenRouter flag is on without a key, without falling back', async () => {
    mocks.getUseOpenRouter.mockReturnValue(true);
    mocks.isCodexSubscriptionActive.mockResolvedValue(true);

    await expect(resolveDesktopSetupModel()).resolves.toBeNull();
    expect(mocks.isCodexSubscriptionActive).not.toHaveBeenCalled();
  });

  it('delegates to the shared credential scan when the flag is off', async () => {
    mocks.isCodexSubscriptionActive.mockResolvedValue(true);

    await expect(resolveDesktopSetupModel()).resolves.toBe(CHATGPT_SETUP_MODEL);
  });
});
