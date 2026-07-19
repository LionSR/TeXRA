import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import {
  inferPersistedFlowModelHandlerCompatibilityKey,
  inferPersistedModelHandlerCompatibilityKey,
} from '@agent/runtime/modelHandlerCompatibilityInference';

const info = vi.fn<AgentTrace['info']>();
const logger: Pick<AgentTrace, 'info'> = { info };

describe('model handler compatibility inference', () => {
  beforeEach(() => {
    info.mockClear();
  });

  it('infers the legacy Google GenAI handler from Content transcripts', () => {
    expect(
      inferPersistedModelHandlerCompatibilityKey(
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
      inferPersistedModelHandlerCompatibilityKey(
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
  });

  it('keeps keyless legacy Copilot transcripts on OpenRouter', () => {
    expect(
      inferPersistedModelHandlerCompatibilityKey(
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
  });

  it('infers from raw persisted flow state before launch constructs a handler', () => {
    expect(
      inferPersistedFlowModelHandlerCompatibilityKey(
        'gpt54',
        {
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
        },
        logger,
      ),
    ).toBe('ModelHandlerGoogleGenAI');
  });

  it('honors an explicitly persisted flow compatibility key', () => {
    expect(
      inferPersistedFlowModelHandlerCompatibilityKey(
        'gemini35f',
        {
          modelHandlerCompatibilityKey: 'ModelHandlerOpenRouterNative',
          conversation: [
            {
              role: 'user',
              parts: [{ text: 'continue' }],
            },
          ],
        },
        logger,
      ),
    ).toBe('ModelHandlerOpenRouterNative');
    expect(info).not.toHaveBeenCalled();
  });

  it('does not log when inference is inconclusive', () => {
    expect(
      inferPersistedModelHandlerCompatibilityKey('gpt54', [], logger),
    ).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });
});
