import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';
import { Effect } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  apiKeySecretName,
  decideModelRoute,
  isUnservedModel,
  OWN_KEY_ROUTE_FACTS,
} from '@texra-ai/llm';
import { readModelOptions } from '@model/computeModelOptions';
import { DEFAULT_MODELS } from '@shared/constants/defaultModels';
import { isModelOptionAvailable } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  hostStores,
  installPlatform,
  setupPlatform,
} from '@test/support/setupPlatform';
import { modelOptionsFrom } from '@texra/model/modelOptions';

const GPT55 = 'openai/gpt-5.5-2026-04-23';
const KIMI_CODING = 'moonshot/kimi-for-coding';

const OPENAI_KEY_SECRETS = { [apiKeySecretName('openai')]: 'sk-openai' };

/** A persisted selection with exactly `models` enabled. */
function onlyEnabled(models: readonly string[]) {
  return {
    enabledExtras: models,
    disabledDefaults: DEFAULT_MODELS.filter((model) => !models.includes(model)),
  };
}

/** Reinstall the fake platform mid-test with the access state the case needs. */
function installAccessPlatform(options: {
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
}) {
  return Effect.promise(() =>
    installPlatform({
      config: options.config,
      globalState: { [GlobalStateKey.MODEL_SELECTION]: onlyEnabled([GPT55]) },
      secrets: options.secrets ?? OPENAI_KEY_SECRETS,
    }),
  );
}

describe('model catalogue direct-route key ownership', () => {
  it('assigns every servable direct route to an API-key provider', () => {
    for (const [modelId, config] of Object.entries(MODEL_CONFIGS)) {
      if (isUnservedModel(config)) continue;
      const route = decideModelRoute(config, OWN_KEY_ROUTE_FACTS);

      expect(
        route.kind,
        `${modelId} (${config.provider}) is servable but has no direct API-key owner`,
      ).not.toBe('no-api-key');
    }
  });
});

describe('model availability', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.MODEL_SELECTION]: onlyEnabled([GPT55]) },
    secrets: OPENAI_KEY_SECRETS,
  });

  it.effect('does not treat a Moonshot key as a Kimi Code credential', () =>
    Effect.gen(function* () {
      yield* installAccessPlatform({
        secrets: { [apiKeySecretName('moonshot')]: 'sk-moonshot' },
      });

      const [model] = modelOptionsFrom(
        yield* readModelOptions(hostStores(), [KIMI_CODING]),
      );

      expect(model).toMatchObject({
        provider: 'kimiCode',
        availability: 'missing-key',
      });
    }),
  );

  it.effect(
    'does not disable API-key access when ChatGPT subscription is preferred but signed out',
    () =>
      Effect.gen(function* () {
        yield* installAccessPlatform({
          config: { 'texra.chatgptCodex.preferSubscription': true },
        });

        const [model] = modelOptionsFrom(
          yield* readModelOptions(hostStores(), [GPT55]),
        );

        expect(model.availability).toBe('provider-key');
        expect(isModelOptionAvailable(model)).toBe(true);
      }),
  );
});
