// Third-party imports
import { BadRequestError as AnthropicBadRequestError } from '@anthropic-ai/sdk';
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent model handlers
import type { AgentTrace } from '@agent/trace';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/anthropic/modelHandlerAnthropic';
import { noopTrace } from '@agent/trace/noopTrace';

// Type imports
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

function createHandler(): ModelHandlerAnthropic {
  const handler = new ModelHandlerAnthropic({
    name: 'test-anthropic',
    label: 'Test Anthropic',
    fullName: 'claude-test',
    shortName: 'claude-test',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsTokenCounting: false,
      supportsReasoning: false,
    },
    // Keeps the unit test independent from the server-side key service.
    openRouterOnly: true,
  });

  (handler as { getStreamingConfig: () => boolean }).getStreamingConfig = () =>
    true;
  return handler;
}

function createStreamStub(error: unknown): unknown {
  return {
    on: vi.fn(),
    controller: { abort: vi.fn() },
    finalMessage: vi.fn(async () => {
      throw error;
    }),
    currentMessage: undefined,
    request_id: 'req_low_credit',
  };
}

describe('Anthropic stream failure logging', () => {
  it('keeps raw stream failures out of visible warning logs', async () => {
    const handler = createHandler();
    const logger = {
      ...noopTrace,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      domain: vi.fn(),
    };
    handler.setLogger(logger as unknown as AgentTrace);

    const providerError = new AnthropicBadRequestError(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'Your credit balance is too low to access the Anthropic API.',
        },
        request_id: 'req_low_credit',
      },
      undefined,
      new Headers([['request-id', 'req_low_credit']]),
    );
    const stream = createStreamStub(providerError);
    const client = {
      beta: {
        messages: {
          stream: vi.fn(() => stream),
        },
      },
    };
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello', citations: null }],
      },
    ];

    await expect(
      handler.createResponse({
        client: client as unknown as Anthropic,
        messages,
        temperature: 0,
      }),
    ).rejects.toBe(providerError);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Stream failed',
      expect.objectContaining({
        data: expect.objectContaining({
          partialTextLength: 0,
        }),
      }),
    );
  });
});
