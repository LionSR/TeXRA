// Third-party imports
import OpenAI from 'openai';
import { ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

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
  const handler = new TestModelHandlerOpenAI(
    buildTestModelConfig({
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
        supportsReasoning: false,
        supportsTokenCounting: false,
      },
      openRouterOnly: true,
    }),
  );
  handler.setLogger(noopTrace);
  return handler;
}

const PARTIAL_CHUNK = new TextEncoder().encode(
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n',
);

type FetchFn = NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'];

function relayClient(fetch: FetchFn): OpenAI {
  return new OpenAI({
    apiKey: 'test-key',
    baseURL: 'https://relay.test/openai/v1',
    maxRetries: 0,
    fetch,
  });
}

async function captureError(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('OpenAI relay stream correlation', () => {
  it('retains the relay request id when the response body fails', async () => {
    const bodyError = new Error('response body failed');
    let pullCount = 0;
    const client = relayClient(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pullCount === 0) {
                pullCount += 1;
                controller.enqueue(PARTIAL_CHUNK);
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
    );

    const caught = await captureError(createHandler().runStreaming(client));

    expect(caught).toMatchObject({ request_id: 'relay-123' });
    expect(normalizeProviderError(caught).requestId).toBe('relay-123');
  });

  it('preserves user aborts after response headers and a partial chunk', async () => {
    const abortController = new AbortController();
    let resolveFirstChunk: (() => void) | undefined;
    const firstChunk = new Promise<void>((resolve) => {
      resolveFirstChunk = resolve;
    });
    let sentChunk = false;
    const client = relayClient(async (_input, init) => {
      let bodyController:
        ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
        pull(controller) {
          if (!sentChunk) {
            sentChunk = true;
            controller.enqueue(PARTIAL_CHUNK);
            resolveFirstChunk?.();
            return;
          }
          return new Promise<void>(() => {});
        },
      });
      init?.signal?.addEventListener(
        'abort',
        () => bodyController?.error(new DOMException('aborted', 'AbortError')),
        { once: true },
      );
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const run = createHandler().runStreaming(client, abortController.signal);
    await firstChunk;
    abortController.abort();

    expect(isUserAbort(await captureError(run))).toBe(true);
  });
});
