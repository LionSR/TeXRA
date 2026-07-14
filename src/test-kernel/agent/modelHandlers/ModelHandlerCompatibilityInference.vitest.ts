import { describe, expect, it } from 'vitest';

import type { ProviderMessage } from '@agent/types/ProviderMessage';
import {
  inferPersistedFlowModelHandlerCompatibilityKey,
  inferPersistedModelHandlerCompatibilityKey,
} from '@agent/runtime/modelHandlerCompatibilityInference';

describe('model handler compatibility inference', () => {
  it('infers the legacy Google GenAI handler from Content transcripts', () => {
    expect(
      inferPersistedModelHandlerCompatibilityKey('gemini35f', [
        {
          role: 'user',
          parts: [{ text: 'continue' }],
        } as ProviderMessage,
      ]),
    ).toBe('ModelHandlerGoogleGenAI');
  });

  it('infers OpenRouter for Google chat transcripts without a stored key', () => {
    expect(
      inferPersistedModelHandlerCompatibilityKey('gemini35f', [
        {
          role: 'user',
          content: [{ type: 'text', text: 'continue' }],
        } as ProviderMessage,
      ]),
    ).toBe('ModelHandlerOpenRouterNative');
  });

  it('keeps keyless legacy Copilot transcripts on OpenRouter', () => {
    expect(
      inferPersistedModelHandlerCompatibilityKey('copilot4o', [
        {
          role: 'user',
          content: [{ type: 'text', text: 'continue' }],
        } as ProviderMessage,
      ]),
    ).toBe('ModelHandlerOpenRouterNative');
  });

  it('infers from raw persisted flow state before launch constructs a handler', () => {
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
  });
});
