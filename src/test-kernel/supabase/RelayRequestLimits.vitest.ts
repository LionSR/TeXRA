import { strict as assert } from 'node:assert';

import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import {
  FREE_TIER_MAX_OUTPUT_TOKENS,
  FREE_TIER_REQUEST_BODY_LIMIT_BYTES,
  clampFreeTierMaxOutputTokens,
  formatRequestBytes,
  readRequestBodyWithinSizeLimit,
} from '../../../supabase/functions/relay/requestLimits';
import {
  classifyPreHeaderFailure,
  getRelayRequestBytes,
  getUpstreamRequestId,
  logRelayFailure,
  RELAY_REQUEST_ID_HEADER,
  withRelayErrorRequestId,
} from '../../../supabase/functions/relay/diagnostics';
import {
  acquireRelayRequestSlot,
  releaseRelaySlotSafely,
  releaseWhenStreamCloses,
} from '../../../supabase/functions/relay/requestGate';
import {
  getCanonicalRelayModelName,
  getRequestLimits,
} from '../../../supabase/functions/relay/models';
import {
  isModelFreeRelayPath,
  isRetiredGoogleGenerateContentPath,
} from '../../../supabase/functions/relay/paths';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** A stream whose first read fails with `error`, like a broken upstream body. */
function failingStream(error: Error): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(error);
    },
  });
}

interface GateClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown>; error: null }>;
}

/** A mock relay RPC client that grants a slot and answers refresh with `refreshed`. */
function createGateClient(
  options: {
    refreshed?: boolean;
    onCall?: (name: string, args: Record<string, unknown>) => void;
  } = {},
): GateClient {
  const { refreshed = true, onCall } = options;
  return {
    async rpc(name, args) {
      onCall?.(name, args);
      let data: Record<string, unknown>;
      if (name === 'relay_request_gate') {
        data = {
          allowed: true,
          slotId: args.p_slot_id,
          activeRequests: 1,
          concurrencyLimit: 2,
          requestsThisMinute: 1,
          rateLimitPerMinute: 20,
        };
      } else if (name === 'relay_request_refresh') {
        data = { refreshed };
      } else {
        data = {};
      }
      return { data, error: null };
    },
  };
}

describe('relay free-tier request limits', () => {
  const errorLogs: unknown[][] = [];

  beforeEach(() => {
    errorLogs.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLogs.push(args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function acquireSlot(client: GateClient) {
    const slot = await acquireRelayRequestSlot(client, crypto.randomUUID(), {
      ratePerMinute: 20,
      concurrent: 2,
    });
    assert.ok(slot.allowed, 'expected slot to be allowed');
    return slot;
  }

  it('reads accepted request streams without changing bytes', async () => {
    const result = await readRequestBodyWithinSizeLimit(
      byteStream([bytes(0, 255), bytes(1)]),
      3,
    );

    if (!result.allowed) assert.fail('expected body under the cap');
    assert.deepEqual([...result.body], [0, 255, 1]);
    assert.equal(result.requestBytes, 3);
  });

  it('stops reading request streams after the cap is exceeded', async () => {
    const result = await readRequestBodyWithinSizeLimit(
      byteStream([bytes(0, 1), bytes(2, 3)]),
      3,
    );

    assert.equal(result.allowed, false);
    assert.equal(result.body, null);
    assert.equal(result.requestBytes, 4);
  });

  // Change detector for production free-tier limits: update deliberately.
  it('pins production free-tier limits and their formatting', () => {
    assert.equal(getRequestLimits('free').concurrent, 4);
    assert.equal(FREE_TIER_REQUEST_BODY_LIMIT_BYTES, 2 * 1024 * 1024);
    assert.equal(
      formatRequestBytes(FREE_TIER_REQUEST_BODY_LIMIT_BYTES),
      '2 MiB',
    );
  });

  it.each([
    {
      name: 'adds an OpenAI-compatible max token cap when missing',
      provider: 'deepseek',
      path: '/v1/chat',
      body: { model: 'deepseek-chat' },
      fieldPath: 'max_tokens',
      expected: {
        model: 'deepseek-chat',
        max_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
      },
    },
    {
      name: 'replaces non-positive OpenAI-compatible max token requests',
      provider: 'deepseek',
      path: '/v1/chat',
      body: { model: 'deepseek-chat', max_tokens: -1 },
      fieldPath: 'max_tokens',
      expected: {
        model: 'deepseek-chat',
        max_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
      },
    },
    {
      name: 'caps Responses API max_output_tokens',
      provider: 'openai',
      path: '/v1/responses',
      body: { model: 'gpt-4.1-mini', max_output_tokens: 128_000 },
      fieldPath: 'max_output_tokens',
      expected: {
        model: 'gpt-4.1-mini',
        max_output_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
      },
    },
    {
      name: 'adds Responses API max_output_tokens when only a decoy field exists',
      provider: 'openai',
      path: '/v1/responses',
      body: { model: 'gpt-4.1-mini', max_tokens: 1024 },
      fieldPath: 'max_output_tokens',
      expected: {
        model: 'gpt-4.1-mini',
        max_tokens: 1024,
        max_output_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
      },
    },
    {
      name: 'caps OpenAI-compatible max_completion_tokens',
      provider: 'openai',
      path: '/v1/chat',
      body: { model: 'gpt-5-mini', max_completion_tokens: 128_000 },
      fieldPath: 'max_completion_tokens',
      expected: {
        model: 'gpt-5-mini',
        max_completion_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
      },
    },
    {
      name: 'uses max_completion_tokens for GPT-5 chat requests without a cap',
      provider: 'openai',
      path: '/v1/chat/completions',
      body: { model: 'gpt-5-mini' },
      fieldPath: 'max_completion_tokens',
      expected: {
        model: 'gpt-5-mini',
        max_completion_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
      },
    },
    {
      name: 'adds chat max_tokens when only a decoy Responses field exists',
      provider: 'openai',
      path: '/v1/chat/completions',
      body: { model: 'gpt-4.1-mini', max_output_tokens: 1024 },
      fieldPath: 'max_tokens',
      expected: {
        model: 'gpt-4.1-mini',
        max_output_tokens: 1024,
        max_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
      },
    },
    {
      name: 'caps sibling OpenAI-compatible max token fields together',
      provider: 'openai',
      path: '/v1/chat',
      body: {
        model: 'gpt-4.1-mini',
        max_completion_tokens: 1024,
        max_tokens: 128_000,
      },
      fieldPath: 'max_tokens',
      expected: {
        model: 'gpt-4.1-mini',
        max_completion_tokens: 1024,
        max_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
      },
    },
    {
      name: 'caps Google Interactions generation_config max_output_tokens',
      provider: 'google',
      path: '/v1beta/interactions',
      body: {
        input: [],
        generation_config: { max_output_tokens: 128_000, temperature: 0.2 },
      },
      fieldPath: 'generation_config.max_output_tokens',
      expected: {
        input: [],
        generation_config: {
          max_output_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
          temperature: 0.2,
        },
      },
    },
    {
      name: 'adds Google Interactions max_output_tokens when missing',
      provider: 'google',
      path: '/v1beta/interactions',
      body: { input: [] },
      fieldPath: 'generation_config.max_output_tokens',
      expected: {
        input: [],
        generation_config: { max_output_tokens: FREE_TIER_MAX_OUTPUT_TOKENS },
      },
    },
    {
      name: 'ignores retired Generate Content configuration fields',
      provider: 'google',
      path: '/v1beta/interactions',
      body: { input: [], generationConfig: { maxOutputTokens: 128_000 } },
      fieldPath: 'generation_config.max_output_tokens',
      expected: {
        input: [],
        generationConfig: { maxOutputTokens: 128_000 },
        generation_config: { max_output_tokens: FREE_TIER_MAX_OUTPUT_TOKENS },
      },
    },
  ])('$name', ({ provider, path, body, fieldPath, expected }) => {
    const result = clampFreeTierMaxOutputTokens(provider, path, body);

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, fieldPath);
    assert.deepEqual(result.body, expected);
  });

  it('preserves OpenAI-compatible max token requests under the cap', () => {
    const body = { model: 'deepseek-chat', max_tokens: 1024 };
    const result = clampFreeTierMaxOutputTokens('deepseek', '/v1/chat', body);

    assert.equal(result.changed, false);
    assert.equal(result.body, body);
  });

  it('treats Google Interactions cancellation as a model-free relay path', () => {
    assert.equal(
      isModelFreeRelayPath('/v1beta/interactions/interaction-123:cancel'),
      true,
    );
    assert.equal(isModelFreeRelayPath('/v1beta/interactions'), false);
    assert.equal(
      isModelFreeRelayPath('/v1beta/interactions/interaction-123'),
      false,
    );
  });

  it('identifies retired Google generation paths without blocking countTokens', () => {
    assert.equal(
      isRetiredGoogleGenerateContentPath(
        '/v1beta/models/gemini-3.5-flash:generateContent',
      ),
      true,
    );
    assert.equal(
      isRetiredGoogleGenerateContentPath(
        '/v1beta/models/gemini-3.5-flash:streamGenerateContent',
      ),
      true,
    );
    assert.equal(
      isRetiredGoogleGenerateContentPath(
        '/v1beta/models/gemini-3.5-flash:countTokens',
      ),
      false,
    );
    assert.equal(
      isRetiredGoogleGenerateContentPath(
        '/relay/v1beta/models/gemini-3.5-flash:generateContent',
      ),
      false,
    );
  });

  it('releases request slots when the upstream stream closes', async () => {
    let releases = 0;
    const wrapped = await releaseWhenStreamCloses(
      byteStream([bytes(1), bytes(2)]),
      async () => {
        releases += 1;
      },
    );
    assert.ok(wrapped, 'expected wrapped stream');

    const reader = wrapped.getReader();
    assert.deepEqual(await reader.read(), { done: false, value: bytes(1) });
    assert.deepEqual(await reader.read(), { done: false, value: bytes(2) });
    assert.deepEqual(await reader.read(), { done: true, value: undefined });
    assert.equal(releases, 1);
  });

  it('classifies failures before upstream headers arrive', () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    const abort = new Error('aborted');
    abort.name = 'AbortError';

    assert.equal(classifyPreHeaderFailure(timeout), 'pre_headers_timeout');
    assert.equal(classifyPreHeaderFailure(abort), 'pre_headers_timeout');
    assert.equal(
      classifyPreHeaderFailure(new TypeError('fetch failed')),
      'pre_headers_failure',
    );
  });

  it('uses only registry-owned model identifiers in diagnostics', () => {
    assert.equal(
      getCanonicalRelayModelName('anthropic/claude-sonnet-4-6'),
      'claude-sonnet-4-6',
    );
    assert.equal(
      getCanonicalRelayModelName('prompt-or-secret@example.com'),
      null,
    );
  });

  it('sanitizes the complete structured failure log', () => {
    logRelayFailure({
      relayRequestId: 'relay-123',
      provider: 'anthropic',
      model: 'prompt-or-secret@example.com',
      requestBytes: 60_000,
      elapsedMs: 390_000,
      failurePhase: 'response_body_failure',
      upstreamRequestId: 'https://secret.example/prompt',
    });

    const serialized = String(errorLogs[0]?.[0]);
    assert.equal(serialized.includes('prompt-or-secret@example.com'), false);
    assert.equal(serialized.includes('secret.example'), false);
    assert.deepEqual(JSON.parse(serialized.slice('[RELAY] '.length)), {
      event: 'upstream_failure',
      relayRequestId: 'relay-123',
      provider: 'anthropic',
      model: null,
      requestBytes: 60_000,
      elapsedMs: 390_000,
      failurePhase: 'response_body_failure',
      upstreamRequestId: null,
    });
  });

  it('exposes relay-generated error ids through the SDK request-id contract', () => {
    const response = withRelayErrorRequestId(
      new Response(null, { status: 504 }),
      'relay-123',
    );

    assert.equal(response.headers.get(RELAY_REQUEST_ID_HEADER), 'relay-123');
    assert.equal(response.headers.get('x-request-id'), 'relay-123');
  });

  it('measures buffered relay request bytes without reading content', () => {
    assert.equal(getRelayRequestBytes('a€😀', null), 8);
    assert.equal(getRelayRequestBytes('\ud800', null), 3);
    assert.equal(getRelayRequestBytes(bytes(0, 1, 2), '999'), 3);
    assert.equal(getRelayRequestBytes(byteStream([]), '60000'), 60_000);
    assert.equal(getRelayRequestBytes(byteStream([]), null), null);
    assert.equal(getRelayRequestBytes(undefined, null), 0);
  });

  it('extracts provider request ids without replacing them', () => {
    assert.equal(
      getUpstreamRequestId(
        new Headers({
          'request-id': 'req-anthropic',
          'x-request-id': 'req-compatible',
        }),
      ),
      'req-anthropic',
    );
    assert.equal(
      getUpstreamRequestId(new Headers({ 'x-goog-request-id': 'req-google' })),
      'req-google',
    );
    assert.equal(getUpstreamRequestId(new Headers()), null);
    assert.equal(
      getUpstreamRequestId(
        new Headers({ 'x-request-id': 'https://secret.example/prompt' }),
      ),
      null,
    );
  });

  it('does not let slot release failures replace upstream failures', async () => {
    await releaseRelaySlotSafely(async () => {
      throw new Error('release failed with sensitive details');
    });

    assert.deepEqual(errorLogs, [['[RELAY] Failed to release request slot']]);
  });

  it('reports upstream response-body failures and releases the slot', async () => {
    const upstreamError = new Error('response body failed');
    let releases = 0;
    const wrapped = await releaseWhenStreamCloses(
      failingStream(upstreamError),
      async () => {
        releases += 1;
      },
      undefined,
      () => {},
      0,
    );
    assert.ok(wrapped, 'expected wrapped stream');

    await assert.rejects(wrapped.getReader().read(), upstreamError);
    assert.equal(releases, 1);
  });

  it('preserves bodyless upstream responses when slot release fails', async () => {
    const wrapped = await releaseWhenStreamCloses(null, async () => {
      throw new Error('release failed');
    });

    assert.equal(wrapped, null);
    assert.deepEqual(errorLogs, [['[RELAY] Failed to release request slot']]);
  });

  it('preserves upstream errors and slot release when the observer throws', async () => {
    const upstreamError = new Error('response body failed');
    const observerError = new Error('sensitive observer details');
    let releases = 0;

    const wrapped = await releaseWhenStreamCloses(
      failingStream(upstreamError),
      async () => {
        releases += 1;
      },
      undefined,
      () => {
        throw observerError;
      },
      0,
    );
    assert.ok(wrapped, 'expected wrapped stream');

    await assert.rejects(wrapped.getReader().read(), upstreamError);
    assert.equal(releases, 1);
    assert.deepEqual(errorLogs, [
      ['[RELAY] Upstream body failure observer failed'],
    ]);
  });

  it('preserves upstream errors when slot release also fails', async () => {
    const upstreamError = new Error('response body failed');

    const wrapped = await releaseWhenStreamCloses(
      failingStream(upstreamError),
      async () => {
        throw new Error('release failed');
      },
    );
    assert.ok(wrapped, 'expected wrapped stream');

    await assert.rejects(wrapped.getReader().read(), upstreamError);
    assert.deepEqual(errorLogs, [['[RELAY] Failed to release request slot']]);
  });

  it('uses the same slot id for gate refresh and release RPCs', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = createGateClient({
      onCall: (name, args) => calls.push({ name, args }),
    });

    const slot = await acquireSlot(client);

    const slotId = calls[0].args.p_slot_id;
    assert.equal(typeof slotId, 'string');
    await slot.refresh();
    await slot.release();
    await slot.release();

    assert.deepEqual(
      calls.map((call) => call.name),
      ['relay_request_gate', 'relay_request_refresh', 'relay_request_release'],
    );
    assert.equal(calls[1].args.p_slot_id, slotId);
    assert.equal(calls[2].args.p_slot_id, slotId);
  });

  it('rejects refreshes when the request slot is already gone', async () => {
    const client = createGateClient({ refreshed: false });

    const slot = await acquireSlot(client);

    await assert.rejects(
      slot.refresh(),
      /relay_request_refresh did not find request slot/,
    );
  });

  it('refreshes request slots while the upstream stream stays open', async () => {
    vi.useFakeTimers();
    let refreshes = 0;
    let releases = 0;
    const wrapped = await releaseWhenStreamCloses(
      byteStream([bytes(1), bytes(2), bytes(3)]),
      async () => {
        releases += 1;
      },
      async () => {
        refreshes += 1;
      },
      undefined,
      10,
    );
    assert.ok(wrapped, 'expected wrapped stream');

    await vi.advanceTimersByTimeAsync(35);
    assert.equal(refreshes, 3);

    const reader = wrapped.getReader();
    await reader.cancel();
    assert.equal(releases, 1);

    await vi.advanceTimersByTimeAsync(35);
    assert.equal(refreshes, 3);
  });

  it('keeps streams open through transient lease refresh failures', async () => {
    vi.useFakeTimers();
    let refreshes = 0;
    let releases = 0;
    const wrapped = await releaseWhenStreamCloses(
      byteStream([bytes(1)]),
      async () => {
        releases += 1;
      },
      async () => {
        refreshes += 1;
        throw new Error('refresh unavailable');
      },
      undefined,
      10,
    );
    assert.ok(wrapped, 'expected wrapped stream');

    await vi.advanceTimersByTimeAsync(30);
    assert.equal(refreshes, 3);
    assert.equal(releases, 0);

    const reader = wrapped.getReader();
    assert.deepEqual(await reader.read(), { done: false, value: bytes(1) });
    assert.deepEqual(await reader.read(), { done: true, value: undefined });
    assert.equal(releases, 1);

    await vi.advanceTimersByTimeAsync(30);
    assert.equal(releases, 1);
  });

  it('releases request slots when stream lease refresh loses the slot', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const client = createGateClient({
      refreshed: false,
      onCall: (name) => calls.push(name),
    });
    const slot = await acquireSlot(client);

    let upstreamBodyFailures = 0;
    const pendingBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
    });

    const wrapped = await releaseWhenStreamCloses(
      pendingBody,
      slot.release,
      slot.refresh,
      () => {
        upstreamBodyFailures += 1;
      },
      10,
    );
    assert.ok(wrapped, 'expected wrapped stream');

    const reader = wrapped.getReader();
    const pendingRead = reader.read();
    const rejectedRead = assert.rejects(
      pendingRead,
      /relay_request_refresh did not find request slot/,
    );
    await vi.advanceTimersByTimeAsync(10);
    assert.deepEqual(calls, [
      'relay_request_gate',
      'relay_request_refresh',
      'relay_request_release',
    ]);

    await rejectedRead;
    assert.equal(upstreamBodyFailures, 0);
  });

  it('releases request slots when the upstream stream is canceled', async () => {
    let releases = 0;
    const wrapped = await releaseWhenStreamCloses(
      byteStream([bytes(1)]),
      async () => {
        releases += 1;
      },
    );
    assert.ok(wrapped, 'expected wrapped stream');

    const reader = wrapped.getReader();
    await reader.cancel();

    assert.equal(releases, 1);
  });

  it('awaits request slot release for null upstream bodies', async () => {
    let releases = 0;
    const wrapped = await releaseWhenStreamCloses(null, async () => {
      releases += 1;
    });

    assert.equal(wrapped, null);
    assert.equal(releases, 1);
  });
});
