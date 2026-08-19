import { describe, expect, it } from 'vitest';

import { inferPersistedFlowModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';

const GOOGLE_KEYLESS_ERROR =
  'Persisted Google sessions without a model-handler identity cannot be resumed.';

describe('model handler compatibility inference', () => {
  it('rejects keyless Google transcripts without inspecting their format', () => {
    expect(() =>
      inferPersistedFlowModelHandlerCompatibilityKey('gemini35f', {
        messages: [
          {
            type: 'user_input',
            content: [{ type: 'text', text: 'continue' }],
          },
        ],
      }),
    ).toThrow(GOOGLE_KEYLESS_ERROR);
  });

  it('honors an explicitly persisted flow compatibility key', () => {
    expect(
      inferPersistedFlowModelHandlerCompatibilityKey('gemini35f', {
        modelHandlerCompatibilityKey: 'ModelHandlerOpenRouterNative',
        messages: [
          {
            role: 'user',
            parts: [{ text: 'continue' }],
          },
        ],
      }),
    ).toBe('ModelHandlerOpenRouterNative');
  });
});
