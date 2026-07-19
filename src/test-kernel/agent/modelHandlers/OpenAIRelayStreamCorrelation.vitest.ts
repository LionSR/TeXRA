// Third-party imports
import OpenAI from 'openai';
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';

// Local imports - agent model handlers
import { noopTrace } from '@agent/trace';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import {
  isUserAbort,
  normalizeProviderError,
} from '@common/errors/sdkErrorUtils';

// Local imports - common errors

class TestModelHandlerOpenAI extends ModelHandlerOpenAI {
  runStreaming(client: OpenAI, signal?: AbortSignal) {
    return this.executeStreamingChat(
      client,
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      },
      signal,
    );
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

  it('preserves user aborts after response headers and a partial chunk', async () => {
    const abortController = new AbortController();
    let resolveFirstChunk: (() => void) | undefined;
    const firstChunk = new Promise<void>((resolve) => {
      resolveFirstChunk = resolve;
    });
    const chunk = new TextEncoder().encode(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n',
    );
    let sentChunk = false;
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://relay.test/openai/v1',
      maxRetries: 0,
      fetch: async (_input, init) => {
        let bodyController:
          ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
          pull(controller) {
            if (!sentChunk) {
              sentChunk = true;
              controller.enqueue(chunk);
              resolveFirstChunk?.();
              return;
            }
            return new Promise<void>(() => {});
          },
        });
        init?.signal?.addEventListener(
          'abort',
          () =>
            bodyController?.error(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });

    const run = createHandler().runStreaming(client, abortController.signal);
    await firstChunk;
    abortController.abort();

    let caught: unknown;
    try {
      await run;
    } catch (error) {
      caught = error;
    }

    expect(isUserAbort(caught)).toBe(true);
  });
});
