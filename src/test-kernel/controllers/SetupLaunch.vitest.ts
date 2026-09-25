import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SETUP_MODEL_BY_PROVIDER } from '@model/setupModelDefaults';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import type { ModelOptionData, UsageRoute } from '@shared/schemas';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

/**
 * The setup launch model is the picker's verdict over the provider setup
 * models, so these cases seed the picker rows and drive the one policy both
 * hosts share: subscription first, a provider's model only on its own
 * credential, and the OpenRouter last resort only where the host opts in.
 */

const mocks = vi.hoisted(() => ({
  rows: new Map<string, Partial<ModelOptionData>>(),
  usageRoutes: new Map<string, UsageRoute>(),
  hasUsableApiKey:
    vi.fn<
      (secrets: unknown, provider: string) => Effect.Effect<boolean, Error>
    >(),
  getUseOpenRouter: vi.fn<() => Effect.Effect<boolean>>(),
}));

vi.mock('@model/computeModelOptions', () => ({
  readModelAvailabilityInputs: (_stores: unknown, models: readonly string[]) =>
    Effect.succeed(models),
  modelOptionsFrom: (models: readonly string[]): ModelOptionData[] =>
    models.map((value) => ({
      value,
      label: value,
      availability: 'missing-key',
      ...mocks.rows.get(value),
    })),
  usageRouteFrom: (_inputs: unknown, model: string) =>
    mocks.usageRoutes.get(model),
}));

vi.mock('@model/apiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@model/apiProviders')>();
  return { ...actual, hasUsableApiKey: mocks.hasUsableApiKey };
});

vi.mock('@utils/config/providerConfig', () => ({
  getUseOpenRouter: mocks.getUseOpenRouter,
}));

const { buildDesktopSetupRunRequest } =
  await import('@controllers/onboarding/setupLaunch');
const { resolveSetupLaunchModel } =
  await import('@model/setupCredentialAccess');

beforeEach(() => {
  mocks.rows.clear();
  mocks.usageRoutes.clear();
  mocks.hasUsableApiKey.mockReset().mockReturnValue(Effect.succeed(false));
  mocks.getUseOpenRouter.mockReset().mockReturnValue(Effect.succeed(false));
});

const secrets = new FakeSecrets();
const stores = makeFakeSettingsStores().stores;

const runSetup = <A, E>(program: Effect.Effect<A, E, LanguageModel>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
    ),
  );

/** Desktop's launch model, read back off the request its host builds. */
async function desktopSetupModel(): Promise<string | null> {
  const request = await runSetup(buildDesktopSetupRunRequest(stores, secrets));
  return request?.config.model ?? null;
}

function launchModel(includeAccessListFallback: boolean) {
  return runSetup(
    resolveSetupLaunchModel(stores, secrets, includeAccessListFallback),
  );
}

describe('resolveSetupLaunchModel', () => {
  it('prefers a subscription-paid setup model over an earlier key-paid one', async () => {
    mocks.rows.set(SETUP_MODEL_BY_PROVIDER.openai, {
      availability: 'provider-key',
    });
    mocks.rows.set(SETUP_MODEL_BY_PROVIDER.xai, {
      availability: 'xai-subscription-access',
    });
    mocks.usageRoutes.set(SETUP_MODEL_BY_PROVIDER.xai, 'xai-subscription');

    await expect(desktopSetupModel()).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.xai,
    );
  });

  it('takes the first available setup model in priority order', async () => {
    mocks.rows.set(SETUP_MODEL_BY_PROVIDER.anthropic, {
      availability: 'provider-key',
    });
    mocks.rows.set(SETUP_MODEL_BY_PROVIDER.kimiCode, {
      availability: 'provider-key',
    });

    await expect(launchModel(false)).resolves.toEqual({
      model: SETUP_MODEL_BY_PROVIDER.anthropic,
      requiresOpenRouter: false,
    });
  });

  it("counts only OpenRouter's own setup model on the OpenRouter route", async () => {
    mocks.getUseOpenRouter.mockReturnValue(Effect.succeed(true));
    mocks.rows.set(SETUP_MODEL_BY_PROVIDER.anthropic, {
      availability: 'openrouter-key',
    });
    mocks.rows.set(SETUP_MODEL_BY_PROVIDER.openRouter, {
      availability: 'openrouter-key',
    });

    await expect(launchModel(false)).resolves.toEqual({
      model: SETUP_MODEL_BY_PROVIDER.openRouter,
      requiresOpenRouter: true,
    });
  });

  it('refuses launch when nothing is available and the OpenRouter flag is on', async () => {
    mocks.getUseOpenRouter.mockReturnValue(Effect.succeed(true));
    mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(true));

    await expect(launchModel(true)).resolves.toBeNull();
  });

  it('offers the OpenRouter last resort only when the caller opts in', async () => {
    mocks.hasUsableApiKey.mockImplementation((_secrets, provider) =>
      Effect.succeed(provider === 'openRouter'),
    );

    await expect(launchModel(true)).resolves.toEqual({
      model: SETUP_MODEL_BY_PROVIDER.openRouter,
      requiresOpenRouter: true,
    });
    await expect(desktopSetupModel()).resolves.toBeNull();
  });
});
