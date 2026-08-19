import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import {
  inferAndLogPersistedModelHandlerCompatibilityKey,
  inferPersistedFlowModelHandlerCompatibilityKey,
} from '@agent/runtime/modelHandlerCompatibilityInference';

const info = vi.fn<AgentTrace['info']>();
const logger: Pick<AgentTrace, 'info'> = { info };

const GOOGLE_KEYLESS_ERROR =
  'Persisted Google sessions without a model-handler identity cannot be resumed.';

describe('model handler compatibility inference', () => {
  beforeEach(() => {
    info.mockClear();
  });

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
    expect(info).not.toHaveBeenCalled();
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
    expect(info).not.toHaveBeenCalled();
  });

  it('does not log when inference is inconclusive', () => {
    expect(
      inferAndLogPersistedModelHandlerCompatibilityKey('gpt54', logger),
    ).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });
});
