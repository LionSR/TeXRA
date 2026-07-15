// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it, vi } from 'vitest';

// Local imports - Supabase relay
import {
  FREE_TIER_MAX_OUTPUT_TOKENS,
  FREE_TIER_REQUEST_BODY_LIMIT_BYTES,
  checkRequestBodySizeLimit,
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
import { isModelFreeRelayPath } from '../../../supabase/functions/relay/paths';

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

describe('relay free-tier request limits', () => {
  it('allows four concurrent free-tier requests', () => {
    assert.equal(getRequestLimits('free').concurrent, 4);
  });

  it('rejects free-tier request bodies over the byte cap', () => {
    assert.deepEqual(checkRequestBodySizeLimit('abc', 3), {
      allowed: true,
      limitBytes: 3,
      requestBytes: 3,
    });
    assert.deepEqual(checkRequestBodySizeLimit('abcd', 3), {
      allowed: false,
      limitBytes: 3,
      requestBytes: 4,
    });
  });

  it('counts UTF-8 bytes rather than JavaScript string length', () => {
    const result = checkRequestBodySizeLimit('€', 2);

    assert.equal(result.allowed, false);
    assert.equal(result.requestBytes, 3);
  });

  it('uses existing byte lengths for binary request bodies', () => {
    const result = checkRequestBodySizeLimit(new Uint8Array([0, 255, 1]), 2);

    assert.equal(result.allowed, false);
    assert.equal(result.requestBytes, 3);
  });

  it('reads accepted request streams without changing bytes', async () => {
    const result = await readRequestBodyWithinSizeLimit(
      byteStream([new Uint8Array([0, 255]), new Uint8Array([1])]),
      3,
    );

    if (!result.allowed) assert.fail('expected body under the cap');
    assert.deepEqual([...result.body], [0, 255, 1]);
    assert.equal(result.requestBytes, 3);
  });

  it('stops reading request streams after the cap is exceeded', async () => {
    const result = await readRequestBodyWithinSizeLimit(
      byteStream([new Uint8Array([0, 1]), new Uint8Array([2, 3])]),
      3,
    );

    assert.equal(result.allowed, false);
    assert.equal(result.body, null);
    assert.equal(result.requestBytes, 4);
  });

  it('uses a loose default limit for normal research requests', () => {
    assert.equal(FREE_TIER_REQUEST_BODY_LIMIT_BYTES, 2 * 1024 * 1024);
    assert.equal(
      formatRequestBytes(FREE_TIER_REQUEST_BODY_LIMIT_BYTES),
      '2 MiB',
    );
  });

  it('adds an OpenAI-compatible max token cap when missing', () => {
    const result = clampFreeTierMaxOutputTokens('deepseek', '/v1/chat', {
      model: 'deepseek-chat',
    });

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'max_tokens');
    assert.deepEqual(result.body, {
      model: 'deepseek-chat',
      max_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
    });
  });

  it('preserves OpenAI-compatible max token requests under the cap', () => {
    const body = { model: 'deepseek-chat', max_tokens: 1024 };
    const result = clampFreeTierMaxOutputTokens('deepseek', '/v1/chat', body);

    assert.equal(result.changed, false);
    assert.equal(result.body, body);
  });

  it('replaces non-positive OpenAI-compatible max token requests', () => {
    const result = clampFreeTierMaxOutputTokens('deepseek', '/v1/chat', {
      model: 'deepseek-chat',
      max_tokens: -1,
    });

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'max_tokens');
    assert.deepEqual(result.body, {
      model: 'deepseek-chat',
      max_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
    });
  });

  it('caps Responses API max_output_tokens', () => {
    const result = clampFreeTierMaxOutputTokens('openai', '/v1/responses', {
      model: 'gpt-4.1-mini',
      max_output_tokens: 128_000,
    });

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'max_output_tokens');
    assert.deepEqual(result.body, {
      model: 'gpt-4.1-mini',
      max_output_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
    });
  });

  it('adds Responses API max_output_tokens when only a decoy field exists', () => {
    const result = clampFreeTierMaxOutputTokens('openai', '/v1/responses', {
      model: 'gpt-4.1-mini',
      max_tokens: 1024,
    });

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'max_output_tokens');
    assert.deepEqual(result.body, {
      model: 'gpt-4.1-mini',
      max_tokens: 1024,
      max_output_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
    });
  });

  it('caps OpenAI-compatible max_completion_tokens', () => {
    const result = clampFreeTierMaxOutputTokens('openai', '/v1/chat', {
      model: 'gpt-5-mini',
      max_completion_tokens: 128_000,
    });

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'max_completion_tokens');
    assert.deepEqual(result.body, {
      model: 'gpt-5-mini',
      max_completion_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
    });
  });

  it('uses max_completion_tokens for GPT-5 chat requests without a cap', () => {
    const result = clampFreeTierMaxOutputTokens(
      'openai',
      '/v1/chat/completions',
      { model: 'gpt-5-mini' },
    );

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'max_completion_tokens');
    assert.deepEqual(result.body, {
      model: 'gpt-5-mini',
      max_completion_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
    });
  });

  it('adds chat max_tokens when only a decoy Responses field exists', () => {
    const result = clampFreeTierMaxOutputTokens(
      'openai',
      '/v1/chat/completions',
      {
        model: 'gpt-4.1-mini',
        max_output_tokens: 1024,
      },
    );

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'max_tokens');
    assert.deepEqual(result.body, {
      model: 'gpt-4.1-mini',
      max_output_tokens: 1024,
      max_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
    });
  });

  it('caps sibling OpenAI-compatible max token fields together', () => {
    const result = clampFreeTierMaxOutputTokens('openai', '/v1/chat', {
      model: 'gpt-4.1-mini',
      max_completion_tokens: 1024,
      max_tokens: 128_000,
    });

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'max_tokens');
    assert.deepEqual(result.body, {
      model: 'gpt-4.1-mini',
      max_completion_tokens: 1024,
      max_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
    });
  });

  it('caps Google generationConfig maxOutputTokens', () => {
    const result = clampFreeTierMaxOutputTokens(
      'google',
      '/v1beta/models/gemini-3.5-flash:streamGenerateContent',
      {
        contents: [],
        generationConfig: { maxOutputTokens: 128_000, temperature: 0.2 },
      },
    );

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'generationConfig.maxOutputTokens');
    assert.deepEqual(result.body, {
      contents: [],
      generationConfig: {
        maxOutputTokens: FREE_TIER_MAX_OUTPUT_TOKENS,
        temperature: 0.2,
      },
    });
  });

  it('caps Google Interactions generation_config max_output_tokens', () => {
    const result = clampFreeTierMaxOutputTokens(
      'google',
      '/v1beta/interactions',
      {
        input: [],
        generation_config: { max_output_tokens: 128_000, temperature: 0.2 },
      },
    );

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'generation_config.max_output_tokens');
    assert.deepEqual(result.body, {
      input: [],
      generation_config: {
        max_output_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
        temperature: 0.2,
      },
    });
  });

  it('adds Google Interactions max_output_tokens when missing', () => {
    const result = clampFreeTierMaxOutputTokens(
      'google',
      '/v1beta/interactions',
      { input: [] },
    );

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'generation_config.max_output_tokens');
    assert.deepEqual(result.body, {
      input: [],
      generation_config: {
        max_output_tokens: FREE_TIER_MAX_OUTPUT_TOKENS,
      },
    });
  });

  it('does not add Generate Content config when only Interactions-style config exists', () => {
    const result = clampFreeTierMaxOutputTokens(
      'google',
      '/v1beta/models/gemini-3.5-flash:generateContent',
      {
        contents: [],
        generation_config: { max_output_tokens: 128_000 },
      },
    );

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'generation_config.max_output_tokens');
    assert.deepEqual(result.body, {
      contents: [],
      generation_config: { max_output_tokens: FREE_TIER_MAX_OUTPUT_TOKENS },
    });
  });

  it('does not add Interactions config when only Generate Content-style config exists', () => {
    const result = clampFreeTierMaxOutputTokens(
      'google',
      '/v1beta/interactions',
      {
        input: [],
        generationConfig: { maxOutputTokens: 128_000 },
      },
    );

    assert.equal(result.changed, true);
    assert.equal(result.fieldPath, 'generationConfig.maxOutputTokens');
    assert.deepEqual(result.body, {
      input: [],
      generationConfig: { maxOutputTokens: FREE_TIER_MAX_OUTPUT_TOKENS },
    });
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

  it('releases request slots when the upstream stream closes', async () => {
    let releases = 0;
    const wrapped = await releaseWhenStreamCloses(
      byteStream([new Uint8Array([1]), new Uint8Array([2])]),
      async () => {
        releases += 1;
      },
    );
    if (wrapped === null) assert.fail('expected wrapped stream');

    const reader = wrapped.getReader();
    assert.deepEqual(await reader.read(), {
      done: false,
      value: new Uint8Array([1]),
    });
    assert.deepEqual(await reader.read(), {
      done: false,
      value: new Uint8Array([2]),
    });
    assert.deepEqual(await reader.read(), {
      done: true,
      value: undefined,
    });
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
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      logRelayFailure({
        relayRequestId: 'relay-123',
        provider: 'anthropic',
        model: 'prompt-or-secret@example.com',
        requestBytes: 60_000,
        elapsedMs: 390_000,
        failurePhase: 'response_body_failure',
        upstreamRequestId: 'https://secret.example/prompt',
      });

      const serialized = String(errorLog.mock.calls[0]?.[0]);
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
    } finally {
      errorLog.mockRestore();
    }
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
    assert.equal(getRelayRequestBytes(new Uint8Array([0, 1, 2]), '999'), 3);
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
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await releaseRelaySlotSafely(async () => {
        throw new Error('release failed with sensitive details');
      });
      assert.deepEqual(errorLog.mock.calls, [
        ['[RELAY] Failed to release request slot'],
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('reports upstream response-body failures and releases the slot', async () => {
    const upstreamError = new Error('response body failed');
    let releases = 0;
    const failingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(upstreamError);
      },
    });
    const wrapped = await releaseWhenStreamCloses(
      failingBody,
      async () => {
        releases += 1;
      },
      undefined,
      0,
      () => {},
    );
    if (wrapped === null) assert.fail('expected wrapped stream');

    await assert.rejects(wrapped.getReader().read(), upstreamError);
    assert.equal(releases, 1);
  });

  it('preserves bodyless upstream responses when slot release fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const wrapped = await releaseWhenStreamCloses(null, async () => {
        throw new Error('release failed');
      });

      assert.equal(wrapped, null);
      assert.deepEqual(errorLog.mock.calls, [
        ['[RELAY] Failed to release request slot'],
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('preserves upstream errors and slot release when the observer throws', async () => {
    const upstreamError = new Error('response body failed');
    const observerError = new Error('sensitive observer details');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let releases = 0;
    const failingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(upstreamError);
      },
    });

    try {
      const wrapped = await releaseWhenStreamCloses(
        failingBody,
        async () => {
          releases += 1;
        },
        undefined,
        0,
        () => {
          throw observerError;
        },
      );
      if (wrapped === null) assert.fail('expected wrapped stream');

      await assert.rejects(wrapped.getReader().read(), upstreamError);
      assert.equal(releases, 1);
      assert.deepEqual(errorLog.mock.calls, [
        ['[RELAY] Upstream body failure observer failed'],
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('preserves upstream errors when slot release also fails', async () => {
    const upstreamError = new Error('response body failed');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(upstreamError);
      },
    });

    try {
      const wrapped = await releaseWhenStreamCloses(failingBody, async () => {
        throw new Error('release failed');
      });
      if (wrapped === null) assert.fail('expected wrapped stream');

      await assert.rejects(wrapped.getReader().read(), upstreamError);
      assert.deepEqual(errorLog.mock.calls, [
        ['[RELAY] Failed to release request slot'],
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('uses the same slot id for gate refresh and release RPCs', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return {
          data:
            name === 'relay_request_gate'
              ? {
                  allowed: true,
                  slotId: args.p_slot_id,
                  activeRequests: 1,
                  concurrencyLimit: 2,
                  requestsThisMinute: 1,
                  rateLimitPerMinute: 20,
                }
              : name === 'relay_request_refresh'
                ? { refreshed: true }
                : {},
          error: null,
        };
      },
    };

    const slot = await acquireRelayRequestSlot(client, crypto.randomUUID(), {
      ratePerMinute: 20,
      concurrent: 2,
    });
    if (!slot.allowed) assert.fail('expected slot to be allowed');

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
    const client = {
      async rpc(name: string, args: Record<string, unknown>) {
        return {
          data:
            name === 'relay_request_gate'
              ? {
                  allowed: true,
                  slotId: args.p_slot_id,
                  activeRequests: 1,
                  concurrencyLimit: 2,
                  requestsThisMinute: 1,
                  rateLimitPerMinute: 20,
                }
              : name === 'relay_request_refresh'
                ? { refreshed: false }
                : {},
          error: null,
        };
      },
    };

    const slot = await acquireRelayRequestSlot(client, crypto.randomUUID(), {
      ratePerMinute: 20,
      concurrent: 2,
    });
    if (!slot.allowed) assert.fail('expected slot to be allowed');

    await assert.rejects(
      slot.refresh(),
      /relay_request_refresh did not find request slot/,
    );
  });

  it('refreshes request slots while the upstream stream stays open', async () => {
    vi.useFakeTimers();
    try {
      let refreshes = 0;
      let releases = 0;
      const wrapped = await releaseWhenStreamCloses(
        byteStream([
          new Uint8Array([1]),
          new Uint8Array([2]),
          new Uint8Array([3]),
        ]),
        async () => {
          releases += 1;
        },
        async () => {
          refreshes += 1;
        },
        10,
      );
      if (wrapped === null) assert.fail('expected wrapped stream');

      await vi.advanceTimersByTimeAsync(35);
      assert.equal(refreshes, 3);

      const reader = wrapped.getReader();
      await reader.cancel();
      assert.equal(releases, 1);

      await vi.advanceTimersByTimeAsync(35);
      assert.equal(refreshes, 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps streams open through transient lease refresh failures', async () => {
    vi.useFakeTimers();
    try {
      let refreshes = 0;
      let releases = 0;
      const wrapped = await releaseWhenStreamCloses(
        byteStream([new Uint8Array([1])]),
        async () => {
          releases += 1;
        },
        async () => {
          refreshes += 1;
          throw new Error('refresh unavailable');
        },
        10,
      );
      if (wrapped === null) assert.fail('expected wrapped stream');

      await vi.advanceTimersByTimeAsync(30);
      assert.equal(refreshes, 3);
      assert.equal(releases, 0);

      const reader = wrapped.getReader();
      assert.deepEqual(await reader.read(), {
        done: false,
        value: new Uint8Array([1]),
      });
      assert.deepEqual(await reader.read(), {
        done: true,
        value: undefined,
      });
      assert.equal(releases, 1);

      await vi.advanceTimersByTimeAsync(30);
      assert.equal(releases, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases request slots when stream lease refresh loses the slot', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const client = {
        async rpc(name: string, args: Record<string, unknown>) {
          calls.push(name);
          return {
            data:
              name === 'relay_request_gate'
                ? {
                    allowed: true,
                    slotId: args.p_slot_id,
                    activeRequests: 1,
                    concurrencyLimit: 2,
                    requestsThisMinute: 1,
                    rateLimitPerMinute: 20,
                  }
                : name === 'relay_request_refresh'
                  ? { refreshed: false }
                  : {},
            error: null,
          };
        },
      };
      const slot = await acquireRelayRequestSlot(client, crypto.randomUUID(), {
        ratePerMinute: 20,
        concurrent: 2,
      });
      if (!slot.allowed) assert.fail('expected slot to be allowed');

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
        10,
        () => {
          upstreamBodyFailures += 1;
        },
      );
      if (wrapped === null) assert.fail('expected wrapped stream');

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
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases request slots when the upstream stream is canceled', async () => {
    let releases = 0;
    const wrapped = await releaseWhenStreamCloses(
      byteStream([new Uint8Array([1])]),
      async () => {
        releases += 1;
      },
    );
    if (wrapped === null) assert.fail('expected wrapped stream');

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
