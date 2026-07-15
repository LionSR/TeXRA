// Third-party imports
import OpenAI from 'openai';
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';

// Local imports - agent model handlers
import { noopTrace } from '@agent/trace';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';

// Local imports - common errors
import { normalizeProviderError } from '@common/errors/sdkErrorUtils';

class TestModelHandlerOpenAI extends ModelHandlerOpenAI {
  runStreaming(client: OpenAI) {
    return this.executeStreamingChat(client, {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    });
  }
}

function createHandler(): TestModelHandlerOpenAI {
  const handler = new TestModelHandlerOpenAI({
    name: 'test-openai',
    label: 'Test OpenAI',
    fullName: 'gpt-test',
    shortName: 'gpt-test',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128_000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning: false,
      supportsTokenCounting: false,
    },
    openRouterOnly: true,
  });
  handler.setLogger(noopTrace);
  return handler;
}

describe('OpenAI relay stream correlation', () => {
  it('retains the relay request id when the response body fails', async () => {
    const bodyError = new Error('response body failed');
    const chunk = new TextEncoder().encode(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n',
    );
    let pullCount = 0;
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://relay.test/openai/v1',
      maxRetries: 0,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pullCount === 0) {
                pullCount += 1;
                controller.enqueue(chunk);
                return;
              }
              controller.error(bodyError);
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'x-relay-request-id': 'relay-123',
            },
          },
        ),
    });

    let caught: unknown;
    try {
      await createHandler().runStreaming(client);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ request_id: 'relay-123' });
    expect(normalizeProviderError(caught).requestId).toBe('relay-123');
  });
});
