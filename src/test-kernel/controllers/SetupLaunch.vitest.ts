import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import type { ModelOptionData, UsageRoute } from '@shared/schemas';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { withEnv } from '@test/support/testEnv';
import { SETUP_MODEL_BY_PROVIDER } from '@texra/model/setupModelDefaults';

/**
 * The setup launch model is the picker's verdict over the provider setup
 * models, so these cases seed the picker rows and drive the one policy both
 * hosts share: subscription first, then a provider's model only on its own
 * credential.
 */

const mocks = vi.hoisted(() => ({
  rows: new Map<string, Partial<ModelOptionData>>(),
  usageRoutes: new Map<string, UsageRoute>(),
}));

vi.mock('@model/computeModelOptions', () => ({
  readModelOptions: (_stores: unknown, models: readonly string[]) =>
    Effect.succeed(
      models.map((model) => ({
        model,
        usageRoute: mocks.usageRoutes.get(model),
      })),
    ),
}));
vi.mock('@texra/model/modelOptions', () => ({
  modelOptionsFrom: (
    options: readonly { model: string }[],
  ): ModelOptionData[] =>
    options.map(({ model: value }) => ({
      value,
      label: value,
      availability: 'missing-key',
      ...mocks.rows.get(value),
    })),
}));

const { resolveSetupLaunchModel } =
  await import('@texra/model/setupCredentialAccess');

beforeEach(() => {
  mocks.rows.clear();
  mocks.usageRoutes.clear();
  secrets = new FakeSecrets();
  fake = makeFakeSettingsStores();
});

/** The key store each case starts empty; keys resolve from it and an empty
 *  environment, never the developer's shell. */
let secrets = new FakeSecrets();
let fake = makeFakeSettingsStores();

const runSetup = <A, E>(program: Effect.Effect<A, E, LanguageModel>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
      withEnv({}),
    ),
  );

function launchModel() {
  return runSetup(resolveSetupLaunchModel(fake.stores, secrets));
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

    await expect(launchModel()).resolves.toBe(SETUP_MODEL_BY_PROVIDER.xai);
  });

  it('takes the first available setup model in priority order', async () => {
    mocks.rows.set(SETUP_MODEL_BY_PROVIDER.anthropic, {
      availability: 'provider-key',
    });
    mocks.rows.set(SETUP_MODEL_BY_PROVIDER.kimiCode, {
      availability: 'provider-key',
    });

    await expect(launchModel()).resolves.toBe(
      SETUP_MODEL_BY_PROVIDER.anthropic,
    );
  });

  it('fails rather than answering "no model" when a key could not be read', async () => {
    mocks.rows.set(SETUP_MODEL_BY_PROVIDER.anthropic, {
      availability: 'key-unreadable',
    });

    await expect(launchModel()).rejects.toMatchObject({
      _tag: 'StateReadFailed',
      key: 'anthropic',
    });
  });
});
