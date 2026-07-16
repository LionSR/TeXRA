// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - handler under test
import { ModelHandlerKimi } from '@agent/modelHandlers/openai/modelHandlerKimi';

function buildHandler(): ModelHandlerKimi {
  const config: ModelConfig = {
    name: 'kimi-test',
    label: 'Kimi Test',
    fullName: 'kimi-k2.5',
    shortName: 'kimi-test',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 8192,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  };
  return new ModelHandlerKimi(config);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'retry-after-ms': '0',
    },
  });
}

describe('Kimi token estimation', () => {
  it('uses the authenticated SDK client with bounded native retries', async () => {
    const controller = new AbortController();
    const post = vi.fn(async () => ({ data: { total_tokens: 37 } }));

    const total = await buildHandler().estimateTokenCount(
      [{ role: 'user', content: 'count this' }],
      {
        client: { post } as unknown as OpenAI,
        signal: controller.signal,
      },
    );

    assert.equal(total, 37);
    expect(post).toHaveBeenCalledWith('/tokenizers/estimate-token-count', {
      body: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: 'count this' }],
      },
      maxRetries: 2,
      timeout: 20_000,
      signal: controller.signal,
    });
  });

  it('retries 408 and 429 responses before succeeding', async () => {
    const responses = [
      jsonResponse({ error: 'timeout' }, 408),
      jsonResponse({ error: 'rate limited' }, 429),
      jsonResponse({ data: { total_tokens: 41 } }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => responses.shift()!);
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://api.moonshot.test/v1',
      fetch: fetchMock,
    });

    assert.equal(
      await buildHandler().estimateTokenCount(
        [{ role: 'user', content: 'retry' }],
        { client },
      ),
      41,
    );
    assert.equal(fetchMock.mock.calls.length, 3);
  });

  it('does not retry a permanent 400 response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: 'bad request' }, 400),
    );
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://api.moonshot.test/v1',
      fetch: fetchMock,
    });

    await assert.rejects(
      buildHandler().estimateTokenCount(
        [{ role: 'user', content: 'invalid' }],
        { client },
      ),
    );
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  it('rejects a malformed successful response without another request', async () => {
    const post = vi.fn(async () => ({ data: { tokens: 37 } }));

    await assert.rejects(
      buildHandler().estimateTokenCount(
        [{ role: 'user', content: 'malformed' }],
        { client: { post } as unknown as OpenAI },
      ),
      /unexpected response shape/,
    );
    assert.equal(post.mock.calls.length, 1);
  });

  it('aborts an active request without retrying', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://api.moonshot.test/v1',
      fetch: fetchMock,
    });
    const pending = buildHandler().estimateTokenCount(
      [{ role: 'user', content: 'cancel' }],
      { client, signal: controller.signal },
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error('cancelled'));

    await assert.rejects(pending);
    assert.equal(fetchMock.mock.calls.length, 1);
  });
});
