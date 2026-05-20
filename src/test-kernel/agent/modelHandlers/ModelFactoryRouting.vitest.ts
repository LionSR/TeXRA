import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { shouldUseResponsesAPI } from '@agent/runtime/ModelFactory';

describe('OpenAI model handler routing', () => {
  it('routes current GPT reasoning tool-use models to Responses by default', () => {
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt54, false)).toBe(true);
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt55, false)).toBe(true);
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt54, true)).toBe(true);
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
});
