import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_SETUP_MODEL,
  SETUP_MODEL_BY_PROVIDER,
} from '@model/setupModelDefaults';

/**
 * `selectSetupCredentialModelExcludingOpenRouter` is the credential-priority core
 * shared by the VS Code extension (`selectLaunchModel`) and desktop
 * (`selectDesktopSetupModel`) setup-launch paths. Exercising it directly
 * guards the priority order (ChatGPT subscription > direct provider key)
 * against silently drifting between hosts again.
 */

const mocks = vi.hoisted(() => ({
  isCodexSubscriptionActive: vi.fn<() => Promise<boolean>>(),
  lookupApiKey:
    vi.fn<
      (secrets: unknown, provider: string) => Promise<string | undefined>
    >(),
  getUseOpenRouter: vi.fn<() => boolean>(),
}));

vi.mock('@model/providerCapabilities', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@model/providerCapabilities')>();
  return {
    ...actual,
    isCodexSubscriptionActive: mocks.isCodexSubscriptionActive,
  };
});

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

const {
  selectSetupCredentialModelExcludingOpenRouter,
  selectDesktopSetupModel,
  resolveSetupLaunchModel,
} = await import('@controllers/onboarding/setupLaunch');

beforeEach(() => {
  mocks.isCodexSubscriptionActive.mockReset().mockResolvedValue(false);
  mocks.lookupApiKey.mockReset().mockResolvedValue(undefined);
  mocks.getUseOpenRouter.mockReset().mockReturnValue(false);
});

function selectCredentialModel(
  includeOpenRouter?: boolean,
): ReturnType<typeof selectSetupCredentialModelExcludingOpenRouter> {
  return selectSetupCredentialModelExcludingOpenRouter(
    {} as never,
    includeOpenRouter,
  );
}

function mockDirectApiKey(provider: string, key: string): void {
  mocks.lookupApiKey.mockImplementation(async (_secrets, p) =>
    p === provider ? key : undefined,
  );
}

describe('selectSetupCredentialModelExcludingOpenRouter', () => {
  it('prefers an active ChatGPT subscription over every other credential', async () => {
    mocks.isCodexSubscriptionActive.mockResolvedValue(true);
    mocks.lookupApiKey.mockResolvedValue('sk-test');

    await expect(selectCredentialModel()).resolves.toBe(CHATGPT_SETUP_MODEL);
  });

  it('falls back to a direct provider API key, skipping openRouter', async () => {
    mockDirectApiKey('anthropic', 'sk-ant-test');

    await expect(selectCredentialModel()).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.anthropic,
    );
    expect(mocks.lookupApiKey).not.toHaveBeenCalledWith(
      expect.anything(),
      'openRouter',
    );
  });

  it('keeps managed direct credentials available when OpenRouter is enabled', async () => {
    mockDirectApiKey('kimiCode', 'kimi-code-test');

    await expect(selectCredentialModel(true)).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.kimiCode,
    );
    expect(mocks.isCodexSubscriptionActive).not.toHaveBeenCalled();
  });

  it('returns null when no credential resolves to a runnable model', async () => {
    await expect(selectCredentialModel()).resolves.toBeNull();
  });
});

describe('selectDesktopSetupModel', () => {
  it('routes through OpenRouter only when the flag is on and a key exists', async () => {
    mocks.getUseOpenRouter.mockReturnValue(true);
    mockDirectApiKey('openRouter', 'or-test');

    await expect(selectDesktopSetupModel()).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.openRouter,
    );
  });

  it('refuses launch when the OpenRouter flag is on without a key, without falling back', async () => {
    mocks.getUseOpenRouter.mockReturnValue(true);
    mocks.isCodexSubscriptionActive.mockResolvedValue(true);

    await expect(selectDesktopSetupModel()).resolves.toBeNull();
    expect(mocks.isCodexSubscriptionActive).not.toHaveBeenCalled();
  });

  it('uses a managed direct key when the OpenRouter flag is on without a key', async () => {
    mocks.getUseOpenRouter.mockReturnValue(true);
    mockDirectApiKey('kimiCode', 'kimi-code-test');

    await expect(selectDesktopSetupModel()).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.kimiCode,
    );
  });

  it('delegates to the shared credential scan when the flag is off', async () => {
    mocks.isCodexSubscriptionActive.mockResolvedValue(true);

    await expect(selectDesktopSetupModel()).resolves.toBe(CHATGPT_SETUP_MODEL);
  });
});

/**
 * `selectDesktopSetupModel` above always calls `resolveSetupLaunchModel`
 * with `includeAccessListFallback: false`, so it never exercises the
 * access-list-default branch the extension opts into. These cases drive
 * `resolveSetupLaunchModel` directly (against the real `decideRunModel`,
 * not a mock) to cover that branch and prove the two hosts' policies
 * actually diverge where intended.
 */
describe('resolveSetupLaunchModel', () => {
  it('falls back to the OpenRouter access-list model when no credential is available and the caller opts in', async () => {
    mockDirectApiKey('openRouter', 'or-test');

    await expect(resolveSetupLaunchModel({} as never, true)).resolves.toEqual({
      model: SETUP_MODEL_BY_PROVIDER.openRouter,
      reason: 'access-list-default',
    });
  });

  it('returns null instead of the access-list fallback when the caller opts out', async () => {
    mockDirectApiKey('openRouter', 'or-test');

    await expect(resolveSetupLaunchModel({} as never, false)).resolves.toBe(
      null,
    );
  });
});
