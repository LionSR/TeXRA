// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { type ModelConfig, ModelProvider } from 'llm-zoo';

// Local imports - agent model handlers
import type { AgentTrace } from '@agent/trace';
import {
  CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_USER_PROMPT,
  estimateTokensFromText,
} from '@agent/modelHandlers/contextManagementConstants';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { noopTrace } from '@agent/trace/noopTrace';
import type { ProviderCapabilityProfile } from '@model/providerCapabilities';

// Local imports - test fixtures
import { buildTestModelConfig } from './testFixtures';

// Type imports
import type { ResponseInputItem } from 'openai/resources/responses/responses';

const COMPACTION_TEST_CONFIG = {
  name: 'gpt-4.1',
  fullName: 'gpt-4.1',
  shortName: 'gpt-4.1',
  label: 'GPT 4.1',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 100,
  contextWindow: 1000,
  capabilities: { supportsReasoning: false, supportsVision: false },
};

function configureHandler(
  handler: ModelHandlerOpenAIResponse,
): ModelHandlerOpenAIResponse {
  handler.setLogger({
    ...noopTrace,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    domain: vi.fn(),
  });
  (handler as { getStreamingConfig: () => boolean }).getStreamingConfig = () =>
    false;
  return handler;
}

function createHandler(): ModelHandlerOpenAIResponse {
  return configureHandler(
    new ModelHandlerOpenAIResponse(
      buildTestModelConfig(COMPACTION_TEST_CONFIG),
    ),
  );
}

class UnsupportedCompactionHandler extends ModelHandlerOpenAIResponse {
  override get supportsManualCompaction(): boolean {
    return false;
  }
}

function createUnsupportedCompactionHandler(): ModelHandlerOpenAIResponse {
  return configureHandler(
    new UnsupportedCompactionHandler(
      buildTestModelConfig(COMPACTION_TEST_CONFIG),
    ),
  );
}

/**
 * Mirrors the ChatGPT-subscription (Codex) provider profile: `store: false`
 * (no stateful server-side response), so the `/responses/compact` endpoint
 * has nothing to act on and `ModelHandlerOpenAIResponse` must route through
 * the client-side summarize-and-resend fallback instead (#7213).
 */
class ClientSideCompactionHandler extends ModelHandlerOpenAIResponse {
  constructor(
    config: ModelConfig,
    private readonly profileContextWindow = 1000,
  ) {
    super(config);
  }

  protected override getActiveProviderCapabilities(): ProviderCapabilityProfile {
    return {
      authMode: 'chatgpt-subscription',
      contextWindow: this.profileContextWindow,
      inputPrice: 0,
      outputPrice: 0,
      openAIResponses: {
        backgroundMode: 'disabled',
        streaming: 'forced',
        webSocket: 'global-toggle',
        supportsTokenCounting: false,
        supportsManualCompaction: true,
        supportsResponseChaining: false,
        storesResponsesServerSide: false,
        supportsInlineInputFileUpload: false,
        supportsToolResultFileUpload: false,
        failWhenFallbackOutputBudgetIsReduced: false,
      },
    };
  }
}

function createClientSideCompactionHandler(
  contextWindow = 1000,
): ModelHandlerOpenAIResponse {
  return configureHandler(
    new ClientSideCompactionHandler(
      buildTestModelConfig(COMPACTION_TEST_CONFIG, { contextWindow }),
      contextWindow,
    ),
  );
}

/**
 * An async-iterable stand-in for the SDK's `ResponseStream`: yields
 * `response.output_text.delta` events, then resolves `finalResponse()`.
 * Exposes an `abort` spy so tests can assert the handler stops consuming once
 * the client-side summary cap is reached.
 */
function createStreamMock(options: {
  deltas?: string[];
  finalResponse?: unknown;
}) {
  const { deltas = [], finalResponse } = options;
  const abort = vi.fn();
  const finalResponseFn = vi.fn(async () => finalResponse);
  return {
    abort,
    finalResponseFn,
    async *[Symbol.asyncIterator]() {
      for (const delta of deltas) {
        yield { type: 'response.output_text.delta', delta };
      }
    },
    finalResponse: finalResponseFn,
  };
}

function createResponse(id: string, inputTokens: number) {
  return {
    id,
    status: 'completed',
    output: [],
    output_text: 'ok',
    usage: { input_tokens: inputTokens },
  };
}

function createMessages(count: number): ResponseInputItem[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user',
    content: `message ${index + 1}`,
  })) as ResponseInputItem[];
}

describe('ModelHandlerOpenAIResponse automatic compaction', () => {
  it('compacts before the next response when the live count crosses the threshold', async () => {
    const handler = createHandler();
    const requests: any[] = [];
    const compactRequests: any[] = [];
    const compactedMessages = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'compacted state' }],
      },
    ] as unknown as ResponseInputItem[];
    const client = {
      responses: {
        inputTokens: {
          // 800 > the 75% threshold (750) of the 1000-token window. Turn 1
          // has nothing to compact (no prior response); turn 2 compacts off
          // this live pre-flight count.
          count: async () => ({ input_tokens: 800 }),
        },
        compact: async (params: any) => {
          compactRequests.push(params);
          return {
            output: compactedMessages,
            usage: { output_tokens: 100 },
          };
        },
        create: async (params: any) => {
          requests.push(params);
          return requests.length === 1
            ? createResponse('resp-before-threshold', 800)
            : createResponse('resp-after-compaction', 150);
        },
      },
    };
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);

    await handler.createResponse({
      client: client as any,
      messages: firstTurnMessages,
      temperature: 0,
    });
    const result = await handler.createResponse({
      client: client as any,
      messages: secondTurnMessages,
      temperature: 0,
    });

    expect(compactRequests).toHaveLength(1);
    expect(compactRequests[0].input).toEqual(secondTurnMessages);
    expect(requests).toHaveLength(2);
    expect(requests[1].previous_response_id).toBeUndefined();
    expect(requests[1].input).toEqual(compactedMessages);
    expect(result.updatedMessages).toEqual(compactedMessages);
  });

  it('reuses a successful compaction across a same-turn retry instead of re-compacting (chain-anchor/payload commit race)', async () => {
    // PocketFlow's Node._exec retries a failed exec() with the identical
    // prepRes, so a same-turn retry resends the exact same `messages` array
    // reference. Compaction's chain-anchor clear (on ResponseChainState)
    // commits immediately and survives that retry permanently; its computed
    // payload (compactionResult) must now survive the same retry too, or the
    // retry silently redoes the compact() call for no reason.
    const handler = createHandler();
    const requests: any[] = [];
    const compactRequests: any[] = [];
    const compactedMessages = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'compacted state' }],
      },
    ] as unknown as ResponseInputItem[];
    const client = {
      responses: {
        inputTokens: {
          // Over the 750-token threshold: turn 2's live count triggers the
          // compaction whose payload the same-turn retry must then reuse.
          count: async () => ({ input_tokens: 800 }),
        },
        compact: async (params: any) => {
          compactRequests.push(params);
          return {
            output: compactedMessages,
            usage: { output_tokens: 100 },
          };
        },
        create: async (params: any) => {
          requests.push(params);
          if (requests.length === 1) {
            return createResponse('resp-before-threshold', 800);
          }
          if (requests.length === 2) {
            // The request that follows a successful compaction fails once,
            // forcing a same-turn retry with the same `messages` reference.
            throw new Error('transient network failure');
          }
          return createResponse('resp-after-compaction', 150);
        },
      },
    };
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);

    await handler.createResponse({
      client: client as any,
      messages: firstTurnMessages,
      temperature: 0,
    });

    await expect(
      handler.createResponse({
        client: client as any,
        messages: secondTurnMessages,
        temperature: 0,
      }),
    ).rejects.toThrow('transient network failure');

    // Same-turn retry: identical `messages` reference as the failed attempt.
    const result = await handler.createResponse({
      client: client as any,
      messages: secondTurnMessages,
      temperature: 0,
    });

    // The /responses/compact endpoint must be hit only once across both
    // attempts — the retry reuses the already-computed compaction instead of
    // silently redoing it.
    expect(compactRequests).toHaveLength(1);
    expect(requests).toHaveLength(3);
    expect(requests[2].previous_response_id).toBeUndefined();
    expect(requests[2].input).toEqual(compactedMessages);
    expect(result.updatedMessages).toEqual(compactedMessages);
  });

  it('does not reuse a stale compaction across a genuinely new turn that keeps the same messages array reference', async () => {
    // Unlike the two synthetic test helpers above (which pass a fresh array
    // per turn), PocketFlow's ModelInvocationNode.post() mutates
    // `shared.messages` IN PLACE (replaceMessagesInPlace: length=0 + push),
    // so the array reference is typically IDENTICAL across turns, not just
    // across retries of one turn. Keying compaction-result reuse on
    // `sourceMessages === messages` alone would therefore also match the next
    // turn and resend the stale post-compaction payload, silently dropping
    // whatever was appended since (see cursor[bot]/codex[bot] review on this
    // PR). This test drives the handler the way the real flow does: one
    // array object, mutated across three turns.
    const handler = createHandler();
    const requests: any[] = [];
    const compactRequests: any[] = [];
    const compactedMessages = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'compacted state' }],
      },
    ] as unknown as ResponseInputItem[];
    let tokenCountCalls = 0;
    const client = {
      responses: {
        inputTokens: {
          count: async () => {
            tokenCountCalls += 1;
            // Turn 1 and turn 2's pre-compaction counts are over the 750
            // threshold (turn 1 has no prior response, so only turn 2
            // compacts); after compaction the transcript is small again, so
            // turn 3 stays under and must NOT compact.
            return { input_tokens: tokenCountCalls <= 2 ? 800 : 160 };
          },
        },
        compact: async (params: any) => {
          compactRequests.push(params);
          return {
            output: compactedMessages,
            usage: { output_tokens: 100 },
          };
        },
        create: async (params: any) => {
          requests.push(params);
          if (requests.length === 1) return createResponse('resp-turn1', 800);
          if (requests.length === 2)
            return createResponse('resp-turn2-compacted', 150);
          return createResponse('resp-turn3', 160);
        },
      },
    };

    // One shared array, exactly as `shared.messages` is across the real
    // PocketFlow cycle.
    const sharedMessages = createMessages(2);

    // Turn 1: below threshold, no compaction.
    await handler.createResponse({
      client: client as any,
      messages: sharedMessages,
      temperature: 0,
    });

    // Turn 2 begins: a new message arrives, appended onto the SAME array
    // (mirrors ToolUseDispatchNode / a new user turn `.push()`-ing onto
    // `shared.messages`).
    const turn2NewMessage = { role: 'user', content: 'message 3' };
    sharedMessages.push(turn2NewMessage as ResponseInputItem);

    // Turn 2's live pre-flight count crosses the compaction threshold
    // (800 > 750), so turn 2 compacts.
    const turn2Result = await handler.createResponse({
      client: client as any,
      messages: sharedMessages,
      temperature: 0,
    });
    expect(compactRequests).toHaveLength(1);
    expect(turn2Result.updatedMessages).toEqual(compactedMessages);

    // Mirror ModelInvocationNode.post(): replaceMessagesInPlace mutates the
    // SAME array object to hold the compacted content instead of replacing
    // the reference.
    sharedMessages.length = 0;
    sharedMessages.push(...(turn2Result.updatedMessages ?? []));

    // Turn 3 begins: another message arrives, appended onto the SAME array
    // object turn 1 and turn 2 both used.
    const turn3NewMessage = { role: 'user', content: 'message 4' };
    sharedMessages.push(turn3NewMessage as ResponseInputItem);

    // Turn 2's response (150 tokens) is well under threshold, so turn 3 must
    // NOT compact again and must send only what's new since the chain
    // anchor (the single message appended after turn 2), not turn 2's stale
    // compacted payload.
    const turn3Result = await handler.createResponse({
      client: client as any,
      messages: sharedMessages,
      temperature: 0,
    });

    expect(compactRequests).toHaveLength(1);
    expect(requests).toHaveLength(3);
    expect(requests[2].previous_response_id).toBe('resp-turn2-compacted');
    expect(requests[2].input).toEqual([turn3NewMessage]);
    expect(turn3Result.updatedMessages).toBeUndefined();
  });

  it('does not call the Responses compact endpoint when compaction is unsupported', async () => {
    const handler = createUnsupportedCompactionHandler();
    const requests: any[] = [];
    const compactRequests: any[] = [];
    const client = {
      responses: {
        inputTokens: {
          count: async () => ({ input_tokens: 100 }),
        },
        compact: async (params: any) => {
          compactRequests.push(params);
          return {
            output: createMessages(1),
            usage: { output_tokens: 100 },
          };
        },
        create: async (params: any) => {
          requests.push(params);
          return requests.length === 1
            ? createResponse('resp-before-threshold', 800)
            : createResponse('resp-without-compaction', 850);
        },
      },
    };
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);

    await handler.createResponse({
      client: client as any,
      messages: firstTurnMessages,
      temperature: 0,
    });
    const result = await handler.createResponse({
      client: client as any,
      messages: secondTurnMessages,
      temperature: 0,
    });

    expect(compactRequests).toHaveLength(0);
    expect(requests).toHaveLength(2);
    expect(requests[1].previous_response_id).toBe('resp-before-threshold');
    expect(requests[1].input).toEqual([secondTurnMessages.at(-1)]);
    expect(result.updatedMessages).toBeUndefined();
  });

  it('summarizes locally and resends a single message when the backend has no stateful compact endpoint (#7213)', async () => {
    const handler = createClientSideCompactionHandler();
    const requests: any[] = [];
    const compactRequests: any[] = [];
    const streamRequests: any[] = [];
    // compactionResult is only populated between the compaction call and this
    // turn's own finalizeResponse() (which clears it on success so it can
    // never leak into a later turn - see createResponseImpl). Snapshot it
    // from inside the outer `create()` mock, the one point still inside that
    // window, rather than reading it back after `createResponse()` resolves.
    let tokensAfterDuringCall: number | undefined;
    const client = {
      responses: {
        compact: async (params: any) => {
          compactRequests.push(params);
          throw new Error(
            'the /responses/compact endpoint should never be called for a stateless backend',
          );
        },
        stream: async (params: any) => {
          streamRequests.push(params);
          // Summary finishes under the client-side cap, so the handler drains
          // the (empty) delta stream and reads the final response.
          return createStreamMock({
            finalResponse: {
              id: 'compaction-summary-response',
              status: 'completed',
              output: [],
              output_text: 'concise summary of the prior turns',
              usage: { output_tokens: 42 },
            },
          });
        },
        create: async (params: any) => {
          requests.push(params);
          if (requests.length === 2) {
            tokensAfterDuringCall = (
              handler as unknown as {
                compactionResult?: { tokensAfter: number };
              }
            ).compactionResult?.tokensAfter;
          }
          return requests.length === 1
            ? createResponse('resp-before-threshold', 800)
            : createResponse('resp-after-client-side-compaction', 150);
        },
      },
    };
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);

    await handler.createResponse({
      client: client as any,
      messages: firstTurnMessages,
      temperature: 0,
    });
    const result = await handler.createResponse({
      client: client as any,
      messages: secondTurnMessages,
      temperature: 0,
    });

    // The stateful endpoint is never reached for this backend.
    expect(compactRequests).toHaveLength(0);

    // The client-side path summarizes via a throwaway streaming call.
    expect(streamRequests).toHaveLength(1);
    expect(streamRequests[0].instructions).toBe(COMPACTION_SYSTEM_PROMPT);
    expect(streamRequests[0].input).toEqual([
      ...secondTurnMessages,
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: COMPACTION_USER_PROMPT }],
      },
    ]);

    const expectedCompactedMessages = [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '[Previous conversation summary]\n\nconcise summary of the prior turns',
          },
        ],
      },
    ];
    expect(requests).toHaveLength(2);
    expect(requests[1].previous_response_id).toBeUndefined();
    expect(requests[1].input).toEqual(expectedCompactedMessages);
    expect(result.updatedMessages).toEqual(expectedCompactedMessages);

    // Issue 2: post-compaction bookkeeping must reflect the INPUT cost of
    // resending the compacted payload, not the summarization call's output
    // tokens (42). The Codex profile disables token counting, so this falls
    // back to a text-length estimate over exactly what gets resent.
    const resentText =
      '[Previous conversation summary]\n\nconcise summary of the prior turns';
    expect(tokensAfterDuringCall).toBe(estimateTokensFromText(resentText));
    expect(tokensAfterDuringCall).not.toBe(42);

    // And after the successful call, compactionResult must NOT survive into
    // a later turn (see the same-turn-retry-vs-next-turn regression test
    // above) - applyCompactionState() clears it unconditionally on success.
    expect(
      (handler as unknown as { compactionResult?: unknown }).compactionResult,
    ).toBeUndefined();
  });

  it('bounds the summary on Codex by aborting the stream once the client-side cap is reached (#7213)', async () => {
    // The Codex backend strips `max_output_tokens` at the wire (asserted in
    // CodexRequestRewrite.vitest.ts), so the summary cap can only be honored
    // client-side. Window is wide enough to hold the (bounded, ~2000-token)
    // summary, and prior usage (9000) still crosses the 75% threshold (7500).
    const handler = createClientSideCompactionHandler(10_000);
    const requests: any[] = [];
    // Enough 100-char chunks to blow well past the 2000-token summary cap
    // (~8000 chars) if the handler failed to stop early.
    const oversizedDeltas = Array.from({ length: 200 }, () => 'x'.repeat(100));
    const fullSummaryChars = oversizedDeltas.join('').length;
    let capturedStream: ReturnType<typeof createStreamMock> | undefined;
    const client = {
      responses: {
        compact: async () => {
          throw new Error('stateless backend must not call /responses/compact');
        },
        stream: async () => {
          capturedStream = createStreamMock({
            deltas: oversizedDeltas,
            finalResponse: {
              id: 'should-not-be-read',
              status: 'completed',
              output: [],
              output_text: oversizedDeltas.join(''),
              usage: { output_tokens: 99999 },
            },
          });
          return capturedStream;
        },
        create: async (params: any) => {
          requests.push(params);
          return requests.length === 1
            ? createResponse('resp-before-threshold', 9000)
            : createResponse('resp-after-bounded-compaction', 150);
        },
      },
    };

    await handler.createResponse({
      client: client as any,
      messages: createMessages(2),
      temperature: 0,
    });
    await handler.createResponse({
      client: client as any,
      messages: createMessages(3),
      temperature: 0,
    });

    // The handler aborted the stream instead of draining it to completion, and
    // never fell back to finalResponse() on the capped path.
    expect(capturedStream?.abort).toHaveBeenCalledTimes(1);
    expect(capturedStream?.finalResponseFn).not.toHaveBeenCalled();

    // The resent summary is bounded near the cap — not the full streamed output.
    const resentInput = requests[1].input as Array<{
      content: Array<{ text: string }>;
    }>;
    const summaryText = resentInput[0].content[0].text;
    const summaryBody = summaryText.replace(
      '[Previous conversation summary]\n\n',
      '',
    );
    expect(summaryBody.length).toBeLessThan(fullSummaryChars);
    expect(estimateTokensFromText(summaryBody)).toBeLessThanOrEqual(
      CLIENT_COMPACTION_SUMMARY_MAX_TOKENS + 100,
    );
    expect(estimateTokensFromText(summaryBody)).toBeGreaterThanOrEqual(
      CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
    );
  });

  it('uses the streamed deltas as the summary when the Codex finalResponse is empty (under cap, #7213)', async () => {
    // The Codex backend leaves the completed response's output empty, so the
    // summary must come from the accumulated `output_text.delta` stream. Here
    // the summary finishes under the cap and finalResponse() carries an empty
    // output — the handler must still return the streamed text and compact,
    // rather than treating the empty finalResponse as an empty summary (which
    // would skip compaction and let the Codex run grow unbounded).
    const handler = createClientSideCompactionHandler();
    const requests: any[] = [];
    const client = {
      responses: {
        compact: async () => {
          throw new Error('stateless backend must not call /responses/compact');
        },
        stream: async () =>
          createStreamMock({
            deltas: ['streamed summary ', 'from the deltas'],
            finalResponse: {
              id: 'codex-empty-final-response',
              status: 'completed',
              output: [],
              output_text: '',
              usage: { output_tokens: 7 },
            },
          }),
        create: async (params: any) => {
          requests.push(params);
          return requests.length === 1
            ? createResponse('resp-before-threshold', 800)
            : createResponse('resp-after-client-side-compaction', 150);
        },
      },
    };

    await handler.createResponse({
      client: client as any,
      messages: createMessages(2),
      temperature: 0,
    });
    const result = await handler.createResponse({
      client: client as any,
      messages: createMessages(3),
      temperature: 0,
    });

    // Compaction happened (not skipped) and the resent summary is the streamed
    // text, not the empty finalResponse extraction.
    const expectedCompactedMessages = [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '[Previous conversation summary]\n\nstreamed summary from the deltas',
          },
        ],
      },
    ];
    expect(requests).toHaveLength(2);
    expect(requests[1].input).toEqual(expectedCompactedMessages);
    expect(result.updatedMessages).toEqual(expectedCompactedMessages);
  });
});
