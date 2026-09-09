import { describe, expect, it } from 'vitest';

import { persistedFlowModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';

describe('persisted flow compatibility key', () => {
  it('reads an explicitly persisted flow compatibility key', () => {
    expect(
      persistedFlowModelHandlerCompatibilityKey({
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

  it('reports no key for a record that carries none', () => {
    // Records are stamped at write time, so a keyless record is malformed
    // rather than old: nothing is inferred back from the model id.
    expect(
      persistedFlowModelHandlerCompatibilityKey({
        messages: [
          {
            type: 'user_input',
            content: [{ type: 'text', text: 'continue' }],
          },
        ],
      }),
    ).toBeUndefined();
  });
});
