import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { shouldUseResponsesAPI } from '@agent/runtime/ModelFactory';

describe('OpenAI model handler routing', () => {
  it('routes current GPT reasoning tool-use models to Responses by default', () => {
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt54, false)).toBe(true);
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt55, false)).toBe(true);
  });

  it('skips Responses routing when OpenRouter is the active proxy', () => {
    // OpenRouter proxies gpt-5* on /v1/chat/completions only — sending a
    // Responses-shaped payload would 404 / mis-route.
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt54, true)).toBe(false);
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt55, true)).toBe(false);
  });

  it('keeps OpenRouter-only models outside the Responses handler', () => {
    expect(
      shouldUseResponsesAPI(
        {
          ...MODEL_CONFIGS.gpt54,
          openRouterOnly: true,
        },
        false,
      ),
    ).toBe(false);
  });

  it('skips Responses routing when function calling is explicitly disabled', () => {
    expect(
      shouldUseResponsesAPI(
        {
          ...MODEL_CONFIGS.gpt54,
          capabilities: {
            ...MODEL_CONFIGS.gpt54.capabilities,
            supportsFunctionCalling: false,
          },
        },
        false,
      ),
    ).toBe(false);
  });
});
