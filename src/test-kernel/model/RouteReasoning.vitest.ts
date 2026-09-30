import { describe, expect, it } from 'vitest';
import { lookup, ReasoningEffort as E, type ModelConfig } from 'llm-zoo';

import { chooseReasoning } from '@model/reasoningChoice';
import { routeReasoning } from '@model/reasoningLevel';
import { modelFileName } from '@shared/model/modelSelection';

const model = (ref: string): ModelConfig => {
  const config = lookup(ref);
  if (!config) throw new Error(`missing ${ref}`);
  return config;
};

describe('routeReasoning', () => {
  it('refuses thinking off where the Gemini route has no switch for it', () => {
    const flash = model('google/gemini-2.5-flash');
    expect(flash.reasoning?.off).toBeDefined();
    const onGemini = routeReasoning(flash, {
      protocol: 'google-interactions',
      codexSubscription: false,
    });
    expect(() => chooseReasoning(onGemini, { effort: E.NONE })).toThrow(
      /cannot turn thinking off/,
    );
  });

  it('records that Qwen does not think where DashScope cannot turn thinking on', () => {
    const qwen = model('dashscope/qwen-plus');
    const onResponses = routeReasoning(qwen, {
      protocol: 'openai-responses',
      codexSubscription: false,
    });
    expect(chooseReasoning(onResponses)).toMatchObject({ thinking: false });
  });

  it('leaves a route that carries every control unchanged', () => {
    const deepseek = model('deepseek/deepseek-flash');
    expect(
      routeReasoning(deepseek, {
        protocol: 'openai-responses',
        codexSubscription: false,
      }),
    ).toBe(deepseek);
  });
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
