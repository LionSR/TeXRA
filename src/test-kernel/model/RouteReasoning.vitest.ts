import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { lookup, ReasoningEffort as E, type ModelConfig } from 'llm-zoo';

import { chooseReasoning, type ReasoningRequest } from '@texra-ai/llm';
import { reasoningFor, type ReasoningRoute } from '@model/reasoningLevel';

import { modelFileName } from '@shared/constants/workflowOutput';
import { FakeStateStore } from '../support/FakePlatform';

const model = (ref: string): ModelConfig => {
  const config = lookup(ref);
  if (!config) throw new Error(`missing ${ref}`);
  return config;
};

const responses: ReasoningRoute = {
  protocol: 'openai-responses',
  codexSubscription: false,
};

const onRoute = (
  config: ModelConfig,
  route: ReasoningRoute,
  request: ReasoningRequest = {},
) => reasoningFor(config, request, new FakeStateStore(), route);

describe('reasoning on a route', () => {
  it.effect(
    'refuses thinking off where the Gemini route has no switch for it',
    () =>
      Effect.gen(function* () {
        const flash = model('google/gemini-2.5-flash');
        expect(flash.reasoning?.off).toBeDefined();
        const refused = yield* Effect.flip(
          onRoute(
            flash,
            { protocol: 'google-interactions', codexSubscription: false },
            { effort: E.NONE },
          ),
        );
        expect(refused.message).toMatch(/cannot turn thinking off/);
      }),
  );

  it.effect(
    'records that Qwen does not think where DashScope cannot turn thinking on',
    () =>
      Effect.gen(function* () {
        expect(
          yield* onRoute(model('dashscope/qwen-plus'), responses),
        ).toMatchObject({ thinking: false });
      }),
  );

  it.effect('leaves a route that carries every control unchanged', () =>
    Effect.gen(function* () {
      const deepseek = model('deepseek/deepseek-flash');
      for (const request of [{}, { effort: E.NONE }, { effort: E.HIGH }]) {
        expect(yield* onRoute(deepseek, responses, request)).toEqual(
          chooseReasoning(deepseek, request),
        );
      }
    }),
  );
});

describe('modelFileName', () => {
  it('names a file by the API id, without provider or selection suffix', () => {
    expect(modelFileName('openai/gpt-6.1-sol@high')).toBe('gpt-6.1-sol');
    expect(modelFileName('anthropic/claude-opus-5-5+pro')).toBe(
      'claude-opus-5-5',
    );
  });

  it('never yields a path separator for a string that names no model', () => {
    expect(modelFileName('someone/unknown@x')).toBe('someone-unknown-x');
  });
});
