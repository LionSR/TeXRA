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

  it('does not infer compatibility for Google transcripts', () => {
    expect(
      inferPersistedFlowModelHandlerCompatibilityKey('gpt54', {
        messages: [
          {
            type: 'user_input',
            content: [{ type: 'text', text: 'continue' }],
          },
        ],
        stateSlices: {
          userChannels: {
            input: {},
            transient: { MODEL: 'gemini35f' },
          },
        },
      }),
    ).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });

  it('prefers the persisted model id over the MODEL variable', () => {
    expect(
      inferPersistedFlowModelHandlerCompatibilityKey('gpt54', {
        modelId: 'gemini35f',
        messages: [
          {
            type: 'user_input',
            content: [{ type: 'text', text: 'continue' }],
          },
        ],
        stateSlices: {
          userChannels: {
            input: {},
            transient: { MODEL: 'gpt54' },
          },
        },
      }),
    ).toBeUndefined();
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
