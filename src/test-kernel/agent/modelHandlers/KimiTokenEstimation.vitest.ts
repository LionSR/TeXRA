// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports - handler under test
import { ModelHandlerKimi } from '@agent/modelHandlers/openai/modelHandlerKimi';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

function buildClient(fetchMock: typeof fetch): OpenAI {
  return new OpenAI({
    apiKey: 'test-key',
    baseURL: 'https://api.moonshot.test/v1',
    fetch: fetchMock,
  });
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

/** An OpenAI-shaped client whose only live member is the token-estimation `post`. */
function stubPostClient(
  post: (path: string, options: unknown) => Promise<{ data: unknown }>,
): OpenAI {
  return { post } as unknown as OpenAI;
}

const TEST_CONFIG = Object.freeze({
  name: 'kimi-test',
  label: 'Kimi Test',
  fullName: 'kimi-k2.5',
  shortName: 'kimi-test',
  provider: ModelProvider.MOONSHOT,
  maxOutputTokens: 8192,
  inputPrice: 0,
  outputPrice: 0,
  contextWindow: 200000,
  openRouterOnly: false,
});

function estimate(
  client: OpenAI,
  content: string,
  signal?: AbortSignal,
): Promise<number> {
  return new ModelHandlerKimi(
    buildTestModelConfig(TEST_CONFIG),
  ).estimateTokenCount([{ role: 'user', content }], { client, signal });
}

describe('Kimi token estimation', () => {
  it('uses the authenticated SDK client with bounded native retries', async () => {
    const controller = new AbortController();
    const post = vi.fn(async () => ({ data: { total_tokens: 37 } }));

    const total = await estimate(
      stubPostClient(post),
      'count this',
      controller.signal,
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

    assert.equal(await estimate(buildClient(fetchMock), 'retry'), 41);
    assert.equal(fetchMock.mock.calls.length, 3);
  });

  it('does not retry a permanent 400 response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: 'bad request' }, 400),
    );

    await assert.rejects(estimate(buildClient(fetchMock), 'invalid'));
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  it('rejects a malformed successful response without another request', async () => {
    const post = vi.fn(async () => ({ data: { tokens: 37 } }));

    await assert.rejects(
      estimate(stubPostClient(post), 'malformed'),
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
    const pending = estimate(
      buildClient(fetchMock),
      'cancel',
      controller.signal,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error('cancelled'));

    await assert.rejects(pending);
    assert.equal(fetchMock.mock.calls.length, 1);
  });
});
