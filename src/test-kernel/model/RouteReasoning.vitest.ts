import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { lookup, ReasoningEffort as E, type ModelConfig } from 'llm-zoo';

import { type ReasoningRequest } from '@texra-ai/llm';
import { decideReasoning, type ReasoningRoute } from '@model/reasoningLevel';

import { modelFileName } from '@texra/utils/files/outputFileUtils';

const model = (ref: string): ModelConfig => {
  const config = lookup(ref);
  if (!config) throw new Error(`missing ${ref}`);
  return config;
};

const onRoute = (
  config: ModelConfig,
  route: ReasoningRoute,
  request: ReasoningRequest = {},
) => decideReasoning(config, request, undefined, route);

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
});

describe('modelFileName', () => {
  it('never yields a path separator for a string that names no model', () => {
    expect(modelFileName('someone/unknown@x')).toBe('someone-unknown-x');
  });
});
