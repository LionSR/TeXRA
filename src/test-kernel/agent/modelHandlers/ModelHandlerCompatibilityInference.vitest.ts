import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import {
  inferAndLogPersistedModelHandlerCompatibilityKey,
  inferPersistedFlowModelHandlerCompatibilityKey,
} from '@agent/runtime/modelHandlerCompatibilityInference';

const info = vi.fn<AgentTrace['info']>();
const logger: Pick<AgentTrace, 'info'> = { info };

describe('model handler compatibility inference', () => {
  beforeEach(() => {
    info.mockClear();
  });

  it.each([
    {
      name: 'infers the legacy Google GenAI handler from Content transcripts',
      model: 'gemini35f',
      message: { role: 'user', parts: [{ text: 'continue' }] },
      expected: 'ModelHandlerGoogleGenAI',
    },
    {
      name: 'infers OpenRouter for Google chat transcripts without a stored key',
      model: 'gemini35f',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'continue' }],
      },
      expected: 'ModelHandlerOpenRouterNative',
    },
    {
      name: 'keeps keyless legacy Copilot transcripts on OpenRouter',
      model: 'copilot4o',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'continue' }],
      },
      expected: 'ModelHandlerOpenRouterNative',
    },
  ])('$name', ({ model, message, expected }) => {
    expect(
      inferAndLogPersistedModelHandlerCompatibilityKey(
        model,
        [message as ProviderMessage],
        logger,
      ),
    ).toBe(expected);
    expect(info).toHaveBeenCalledWith(
      'Inferred model-handler compatibility for keyless persisted run',
      { data: { model, compatibilityKey: expected } },
    );
  });

  it('keeps launch-time flow inference silent until persistence', () => {
    expect(
      inferPersistedFlowModelHandlerCompatibilityKey('gpt54', {
        messages: [
          {
            role: 'user',
            parts: [{ text: 'continue' }],
          },
        ],
        stateSlices: {
          userChannels: {
            input: {},
            transient: { MODEL: 'gemini35f' },
          },
        },
      }),
    ).toBe('ModelHandlerGoogleGenAI');
    expect(info).not.toHaveBeenCalled();
  });

  it('honors an explicitly persisted flow compatibility key', () => {
    expect(
      inferPersistedFlowModelHandlerCompatibilityKey('gemini35f', {
        modelHandlerCompatibilityKey: 'ModelHandlerOpenRouterNative',
        conversation: [
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
      inferAndLogPersistedModelHandlerCompatibilityKey('gpt54', [], logger),
    ).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });
});
