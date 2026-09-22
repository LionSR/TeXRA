import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_SETUP_MODEL,
  SETUP_MODEL_BY_PROVIDER,
  XAI_SETUP_MODEL,
} from '@model/setupModelDefaults';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

/**
 * `selectSetupCredentialModelExcludingOpenRouter` is the credential-priority
 * core shared by the VS Code extension (`selectLaunchModel`) and desktop
 * (`buildDesktopSetupRunRequest`) setup-launch paths. Exercising it directly
 * guards the priority order (ChatGPT subscription > Grok subscription > direct key)
 * against silently drifting between hosts again, and the "skips OpenRouter"
 * arm is not observable through `resolveSetupLaunchModel`, which probes the
 * OpenRouter key first by design.
 */

const mocks = vi.hoisted(() => ({
  isCodexSubscriptionActive: vi.fn<() => Effect.Effect<boolean, Error>>(),
  isXaiSubscriptionActive: vi.fn<() => Effect.Effect<boolean, Error>>(),
  hasUsableApiKey:
    vi.fn<
      (secrets: unknown, provider: string) => Effect.Effect<boolean, Error>
    >(),
  getUseOpenRouter: vi.fn<() => Effect.Effect<boolean>>(),
  getProviderEndpoint: vi.fn<() => Effect.Effect<string>>(),
  useChinaRegion: vi.fn<() => Effect.Effect<boolean>>(),
  getGLMCodingPlan: vi.fn<() => Effect.Effect<boolean>>(),
}));

vi.mock('@model/providerCapabilities', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@model/providerCapabilities')>();
  return {
    ...actual,
    isCodexSubscriptionActive: mocks.isCodexSubscriptionActive,
    isXaiSubscriptionActive: mocks.isXaiSubscriptionActive,
  };
});

vi.mock('@model/apiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@model/apiProviders')>();
  return { ...actual, hasUsableApiKey: mocks.hasUsableApiKey };
});

vi.mock('@utils/config/providerConfig', () => ({
  getUseOpenRouter: mocks.getUseOpenRouter,
  getProviderEndpoint: mocks.getProviderEndpoint,
  useChinaRegion: mocks.useChinaRegion,
  getGLMCodingPlan: mocks.getGLMCodingPlan,
}));

const {
  buildDesktopSetupRunRequest,
  selectSetupCredentialModelExcludingOpenRouter,
  resolveSetupLaunchModel,
} = await import('@controllers/onboarding/setupLaunch');

beforeEach(() => {
  mocks.isCodexSubscriptionActive
    .mockReset()
    .mockReturnValue(Effect.succeed(false));
  mocks.isXaiSubscriptionActive
    .mockReset()
    .mockReturnValue(Effect.succeed(false));
  mocks.hasUsableApiKey.mockReset().mockReturnValue(Effect.succeed(false));
  mocks.getUseOpenRouter.mockReset().mockReturnValue(Effect.succeed(false));
  mocks.getProviderEndpoint.mockReset().mockReturnValue(Effect.succeed(''));
  mocks.useChinaRegion.mockReset().mockReturnValue(Effect.succeed(true));
  mocks.getGLMCodingPlan.mockReset().mockReturnValue(Effect.succeed(false));
});

/**
 * The store every setup-launch path now takes. Its contents never matter
 * here: `hasUsableApiKey` is mocked, so the store is only passed through.
 */
const secrets = new FakeSecrets();
const stores = makeFakeSettingsStores().stores;

/** Run a setup-launch program with the one process service its subscription
 *  probes yield: the unavailable port, since this host has no editor. */
const runSetup = <A>(program: Effect.Effect<A, Error, LanguageModel>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
    ),
  );

function selectCredentialModel(
  includeOpenRouter?: boolean,
): Promise<string | null> {
  return runSetup(
    selectSetupCredentialModelExcludingOpenRouter(
      stores,
      secrets,
      includeOpenRouter,
    ),
  );
}

/**
 * Desktop's launch model, read back off the request its host actually builds.
 * `buildDesktopSetupRunRequest` is the entry point `packages/desktop` calls,
 * so the resolved model is asserted through the same path a launch takes -
 * including the request validation that stands between the resolution and the
 * launch - rather than by re-deriving the projection here.
 */
async function desktopSetupModel(): Promise<string | null> {
  const request = await runSetup(buildDesktopSetupRunRequest(stores, secrets));
  return request?.config.model ?? null;
}

function launchModel(
  includeAccessListFallback: boolean,
): Promise<{ model: string; reason: string } | null> {
  return runSetup(
    resolveSetupLaunchModel(stores, secrets, includeAccessListFallback),
  );
}

function mockDirectApiKey(provider: string): void {
  mocks.hasUsableApiKey.mockImplementation((_secrets, p) =>
    Effect.succeed(p === provider),
  );
}

describe('selectSetupCredentialModelExcludingOpenRouter', () => {
  it('prefers an active ChatGPT subscription over every other credential', async () => {
    mocks.isCodexSubscriptionActive.mockReturnValue(Effect.succeed(true));
    mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(true));

    await expect(selectCredentialModel()).resolves.toBe(CHATGPT_SETUP_MODEL);
  });

  it('uses an active Grok subscription before provider keys', async () => {
    mocks.isXaiSubscriptionActive.mockReturnValue(Effect.succeed(true));
    mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(true));

    await expect(selectCredentialModel()).resolves.toBe(XAI_SETUP_MODEL);
    expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
  });

  it('falls back to a direct provider API key, skipping openRouter', async () => {
    mockDirectApiKey('anthropic');

    await expect(selectCredentialModel()).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.anthropic,
    );
    expect(mocks.hasUsableApiKey).not.toHaveBeenCalledWith(
      expect.anything(),
      'openRouter',
    );
  });

  it('continues to a later provider when an earlier API key read fails', async () => {
    mocks.hasUsableApiKey.mockImplementation((_secrets, provider) =>
      provider === 'openai'
        ? Effect.fail(new Error('openai key read failed'))
        : Effect.succeed(provider === 'anthropic'),
    );

    await expect(selectCredentialModel()).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.anthropic,
    );
  });

  it.each([
    {
      subscription: 'ChatGPT',
      fail: () =>
        mocks.isCodexSubscriptionActive.mockReturnValueOnce(
          Effect.fail(new Error('chatgpt offline')),
        ),
    },
    {
      subscription: 'Grok',
      fail: () =>
        mocks.isXaiSubscriptionActive.mockReturnValueOnce(
          Effect.fail(new Error('grok offline')),
        ),
    },
  ])(
    'falls back to a provider key when the $subscription probe fails',
    async ({ fail }) => {
      fail();
      mockDirectApiKey('anthropic');

      await expect(selectCredentialModel()).resolves.toBe(
        SETUP_MODEL_BY_PROVIDER.anthropic,
      );
    },
  );

  it('keeps managed direct credentials available when OpenRouter is enabled', async () => {
    mockDirectApiKey('kimiCode');

    await expect(selectCredentialModel(true)).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.kimiCode,
    );
    expect(mocks.isCodexSubscriptionActive).not.toHaveBeenCalled();
    expect(mocks.isXaiSubscriptionActive).not.toHaveBeenCalled();
  });

  it('returns null when no credential resolves to a runnable model', async () => {
    await expect(selectCredentialModel()).resolves.toBeNull();
  });
});

/**
 * Desktop's setup-launch path, end to end through
 * `buildDesktopSetupRunRequest`: the OpenRouter access-list fallback stays
 * opted out, and the model that comes back out is the one the host launches.
 */
describe('buildDesktopSetupRunRequest', () => {
  it('routes through OpenRouter only when the flag is on and a key exists', async () => {
    mocks.getUseOpenRouter.mockReturnValue(Effect.succeed(true));
    mockDirectApiKey('openRouter');

    await expect(desktopSetupModel()).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.openRouter,
    );
  });

  it('refuses launch when the OpenRouter flag is on without a key, without falling back', async () => {
    mocks.getUseOpenRouter.mockReturnValue(Effect.succeed(true));
    mocks.isCodexSubscriptionActive.mockReturnValue(Effect.succeed(true));

    await expect(desktopSetupModel()).resolves.toBeNull();
    expect(mocks.isCodexSubscriptionActive).not.toHaveBeenCalled();
    expect(mocks.isXaiSubscriptionActive).not.toHaveBeenCalled();
  });

  it('uses a managed direct key when the OpenRouter flag is on without a key', async () => {
    mocks.getUseOpenRouter.mockReturnValue(Effect.succeed(true));
    mockDirectApiKey('kimiCode');

    await expect(desktopSetupModel()).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.kimiCode,
    );
  });

  it('delegates to the shared credential scan when the flag is off', async () => {
    mocks.isCodexSubscriptionActive.mockReturnValue(Effect.succeed(true));

    await expect(desktopSetupModel()).resolves.toBe(CHATGPT_SETUP_MODEL);
  });

  it('launches with Grok for a Grok-only user when the flag is off', async () => {
    mocks.isXaiSubscriptionActive.mockReturnValue(Effect.succeed(true));

    await expect(desktopSetupModel()).resolves.toBe(XAI_SETUP_MODEL);
  });
});

/**
 * The desktop cases above always call `resolveSetupLaunchModel` with
 * `includeAccessListFallback: false`, so they never exercise the
 * access-list-default branch the extension opts into. These cases drive the
 * same function with the fallback enabled (against the real `decideRunModel`,
 * not a mock) to cover that branch and prove the two hosts' policies
 * actually diverge where intended.
 */
describe('resolveSetupLaunchModel', () => {
  it.each([
    {
      subscription: 'ChatGPT',
      model: CHATGPT_SETUP_MODEL,
      activate: () =>
        mocks.isCodexSubscriptionActive.mockReturnValue(Effect.succeed(true)),
    },
    {
      subscription: 'Grok',
      model: XAI_SETUP_MODEL,
      activate: () =>
        mocks.isXaiSubscriptionActive.mockReturnValue(Effect.succeed(true)),
    },
  ])(
    'continues to an active $subscription subscription when the OpenRouter key read fails',
    async ({ model, activate }) => {
      mocks.hasUsableApiKey.mockReturnValueOnce(
        Effect.fail(new Error('keychain locked')),
      );
      activate();

      await expect(launchModel(false)).resolves.toEqual({
        model,
        reason: 'credential',
      });
    },
  );

  it('falls back to the OpenRouter access-list model when no credential is available and the caller opts in', async () => {
    mockDirectApiKey('openRouter');

    await expect(launchModel(true)).resolves.toEqual({
      model: SETUP_MODEL_BY_PROVIDER.openRouter,
      reason: 'access-list-default',
    });
  });

  it('returns null instead of the access-list fallback when the caller opts out', async () => {
    mockDirectApiKey('openRouter');

    await expect(launchModel(false)).resolves.toBe(null);
  });
});
