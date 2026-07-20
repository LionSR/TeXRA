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

  it('infers the legacy Google GenAI handler from Content transcripts', () => {
    expect(
      inferAndLogPersistedModelHandlerCompatibilityKey(
        'gemini35f',
        [
          {
            role: 'user',
            parts: [{ text: 'continue' }],
          } as ProviderMessage,
        ],
        logger,
      ),
    ).toBe('ModelHandlerGoogleGenAI');
    expect(info).toHaveBeenCalledWith(
      'Inferred model-handler compatibility for keyless persisted run',
      {
        data: {
          model: 'gemini35f',
          compatibilityKey: 'ModelHandlerGoogleGenAI',
        },
      },
    );
  });

  it('infers OpenRouter for Google chat transcripts without a stored key', () => {
    expect(
      inferAndLogPersistedModelHandlerCompatibilityKey(
        'gemini35f',
        [
          {
            role: 'user',
            content: [{ type: 'text', text: 'continue' }],
          } as ProviderMessage,
        ],
        logger,
      ),
    ).toBe('ModelHandlerOpenRouterNative');
    expect(info).toHaveBeenCalledWith(
      'Inferred model-handler compatibility for keyless persisted run',
      {
        data: {
          model: 'gemini35f',
          compatibilityKey: 'ModelHandlerOpenRouterNative',
        },
      },
    );
  });

  it('keeps keyless legacy Copilot transcripts on OpenRouter', () => {
    expect(
      inferAndLogPersistedModelHandlerCompatibilityKey(
        'copilot4o',
        [
          {
            role: 'user',
            content: [{ type: 'text', text: 'continue' }],
          } as ProviderMessage,
        ],
        logger,
      ),
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
