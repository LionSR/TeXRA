import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Layer } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';

import { assert, describe, expect } from 'vitest';

import {
  apiKeySecretName,
  isOpenRouterRoutingUnsupported,
  selectModel,
  shouldRouteModelThroughOpenRouter,
} from '@texra-ai/llm';
import { bindModel } from '@agent/runtime/run/modelBinding';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import { AgentCategory } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { hostStores, setupPlatform } from '@test/support/setupPlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';

const GPT4O = 'openai/gpt-4o-2024-11-20';

describe('shouldRouteModelThroughOpenRouter', () => {
  it.each([
    {
      name: 'routes OpenRouter-only models through OpenRouter',
      config: { openRouterOnly: true, requiresResponsesAPI: false },
      useOpenRouter: false,
      expected: true,
    },
    {
      name: 'routes ordinary models through OpenRouter when the global mode is enabled',
      config: { openRouterOnly: false, requiresResponsesAPI: false },
      useOpenRouter: true,
      expected: true,
    },
    {
      name: 'does not route Responses API models through OpenRouter',
      config: { openRouterOnly: true, requiresResponsesAPI: true },
      useOpenRouter: true,
      expected: false,
    },
    {
      name: 'does not override a managed direct route',
      config: {
        openRouterOnly: false,
        provider: 'moonshot',
        kimiSubscription: true,
        baseUrl: 'https://api.kimi.com/coding/v1',
      },
      useOpenRouter: true,
      expected: false,
    },
  ])('$name', ({ config, useOpenRouter, expected }) => {
    expect(shouldRouteModelThroughOpenRouter(config, useOpenRouter)).toBe(
      expected,
    );
  });
});

describe('isOpenRouterRoutingUnsupported', () => {
  const config = { openRouterOnly: false, requiresResponsesAPI: false };

  it('rejects a route that would discard a requested reasoning mode', () => {
    expect(isOpenRouterRoutingUnsupported(config, true, 'pro')).toBe(true);
  });

  it('accepts the same model on OpenRouter when no mode is requested', () => {
    expect(isOpenRouterRoutingUnsupported(config, true, undefined)).toBe(false);
  });

  it('does not silently change access routes for a Responses API model', () => {
    expect(
      isOpenRouterRoutingUnsupported(
        { ...config, requiresResponsesAPI: true },
        true,
        'pro',
      ),
    ).toBe(true);
  });
});

describe('bindModel', () => {
  setupPlatform({
    globalState: {
      [GlobalStateKey.USE_OPENROUTER]: true,
      [GlobalStateKey.PREFER_SHORT_MODEL_NAMES]: true,
    },
    secrets: { [apiKeySecretName('openai')]: 'openai-key' },
  });

  const bind = (modelId: string) => {
    const selected = selectModel(modelId);
    assert(selected, `${modelId} is registered`);
    return Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.provide(
            Layer.merge(
              testHttpClientLayer,
              LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
            ),
          )(
            bindModel({
              modelId,
              config: selected.config,
              stores: hostStores(),
              compatibilityKey: null,
              agentCategory: AgentCategory.Workflow,
              temperature: 0,
            }),
          ),
        ),
      ),
    );
  };

  it.effect(
    'rejects a pro-mode request the live OpenRouter choice would discard',
    () =>
      Effect.gen(function* () {
        // The route the picker already reports as unavailable: a saved agent or a
        // CLI config must fail with the instruction, not run without the mode.
        const exit = yield* Effect.promise(() =>
          bind('openai/gpt-5.6-sol+pro'),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const message = String(Cause.squash(exit.cause));
        expect(message).toContain('in pro mode is not served by OpenRouter');
        expect(message).toContain('Disable OpenRouter');
      }),
  );

  it.effect('sends the short model name when the preference is on', () =>
    Effect.gen(function* () {
      yield* hostStores().globalState.update(
        GlobalStateKey.USE_OPENROUTER,
        false,
      );

      const exit = yield* Effect.promise(() => bind(GPT4O));

      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      expect(MODEL_CONFIGS[GPT4O].id).not.toBe(MODEL_CONFIGS[GPT4O].shortName);
      expect(exit.value.origin.requestedModel).toBe(
        MODEL_CONFIGS[GPT4O].shortName,
      );
    }),
  );

  it.effect(
    "sends OpenAI's own request fields only to OpenAI's own endpoint",
    () =>
      Effect.gen(function* () {
        const stores = hostStores();
        yield* stores.globalState.update(GlobalStateKey.USE_OPENROUTER, false);
        const cacheKeyOn = (endpoint: string | undefined) =>
          Effect.gen(function* () {
            yield* stores.globalState.update(
              GlobalStateKey.ENDPOINT_OPENAI,
              endpoint,
            );
            const exit = yield* Effect.promise(() => bind(GPT4O));
            assert(Exit.isSuccess(exit));
            const turn = yield* exit.value.model.prepareTurn({
              messages: [
                { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
              ],
              cacheKey: 'run-1',
            });
            assert(turn.protocol === 'openai-responses');
            return turn.controls.promptCacheKey;
          });
        expect(yield* cacheKeyOn(undefined)).toBe('run-1');
        // A proxy, Azure or a local gateway may refuse OpenAI's own fields.
        expect(yield* cacheKeyOn('https://gateway.example/v1')).toBeUndefined();
      }),
  );
});
