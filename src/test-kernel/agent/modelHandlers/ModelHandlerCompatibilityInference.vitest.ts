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

/** Keyless flow state whose only model hint is the MODEL channel variable. */
function keylessFlowState(modelVariable: string) {
  return {
    messages: [
      {
        type: 'user_input',
        content: [{ type: 'text', text: 'continue' }],
      },
    ],
    stateSlices: {
      userChannels: {
        input: {},
        transient: { MODEL: modelVariable },
      },
    },
  };
}

describe('model handler compatibility inference', () => {
  beforeEach(() => {
    info.mockClear();
  });

  it('keeps keyless legacy Copilot transcripts on OpenRouter', () => {
    expect(
      inferAndLogPersistedModelHandlerCompatibilityKey('copilot4o', logger),
    ).toBe('ModelHandlerOpenRouterNative');
    expect(info).toHaveBeenCalledWith(
      'Inferred model-handler compatibility for keyless persisted run',
      {
        data: {
          model: 'copilot4o',
          compatibilityKey: 'ModelHandlerOpenRouterNative',
        },
      },
    );
  });

  it('rejects keyless Google transcripts without inspecting their format', () => {
    expect(() =>
      inferPersistedFlowModelHandlerCompatibilityKey(
        'gpt54',
        keylessFlowState('gemini35f'),
      ),
    ).toThrow(GOOGLE_KEYLESS_ERROR);
    expect(info).not.toHaveBeenCalled();
  });

  it('prefers the persisted model id over the MODEL variable', () => {
    expect(() =>
      inferPersistedFlowModelHandlerCompatibilityKey('gpt54', {
        modelId: 'gemini35f',
        ...keylessFlowState('gpt54'),
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

  it('infers from the model alone when the record carries no parseable messages', () => {
    expect(
      inferPersistedFlowModelHandlerCompatibilityKey('gpt54', {
        stateSlices: {
          userChannels: {
            input: {},
            transient: { MODEL: 'copilot4o' },
          },
        },
      }),
    ).toBe('ModelHandlerOpenRouterNative');
  });

  it('does not log when inference is inconclusive', () => {
    expect(
      inferAndLogPersistedModelHandlerCompatibilityKey('gpt54', logger),
    ).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });
});
