// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { type ModelConfig, ModelProvider } from 'llm-zoo';
import { APIUserAbortError } from 'openai';

// Local imports
import { noopTrace, type AgentTrace } from '@agent/trace';
import {
  CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_USER_PROMPT,
  estimateTokensFromText,
} from '@agent/modelHandlers/contextManagementConstants';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import type { ProviderCapabilityProfile } from '@model/providerCapabilities';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

const COMPACTION_TEST_CONFIG = Object.freeze({
  name: 'gpt-4.1',
  fullName: 'gpt-4.1',
  shortName: 'gpt-4.1',
  label: 'GPT 4.1',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 100,
  contextWindow: 1000,
  capabilities: Object.freeze({
    supportsReasoning: false,
    supportsVision: false,
  }),
});

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
  // getStreamingConfig is public on ModelHandlerOpenAIResponse; stub it
  // rather than poking a private-typed cast.
  vi.spyOn(handler, 'getStreamingConfig').mockReturnValue(false);
  return handler;
}

function createHandler(): ModelHandlerOpenAIResponse {
  return configureHandler(
    new ModelHandlerOpenAIResponse(
      buildTestModelConfig(COMPACTION_TEST_CONFIG),
    ),
  );
}

/** A request routed through OpenRouter (`openRouterOnly` forces the route on
 *  regardless of the global toggle). */
function createOpenRouterRoutedHandler(): ModelHandlerOpenAIResponse {
  return configureHandler(
    new ModelHandlerOpenAIResponse(
      buildTestModelConfig(COMPACTION_TEST_CONFIG, { openRouterOnly: true }),
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

function userTextMessage(text: string): ResponseInputItem {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  } as unknown as ResponseInputItem;
}

function compactedState(): ResponseInputItem[] {
  return [userTextMessage('compacted state')];
}

/** 800 > the 750-token (75%) threshold of the 1000-token test window. */
const OVER_THRESHOLD_COUNT = async () => ({ input_tokens: 800 });

/** A /responses/compact mock returning `output`, optionally recording params. */
function compactTo(output: ResponseInputItem[], sink?: any[]) {
  return async (params: any) => {
    sink?.push(params);
    return { output, usage: { output_tokens: 100 } };
  };
}

/** A responses.create mock that records params and dispatches by attempt. */
function recordCreate(requests: any[], respond: (attempt: number) => unknown) {
  return async (params: any) => {
    requests.push(params);
    return respond(requests.length);
  };
}

/** Turn 1 sits over the threshold (800); the post-compaction resend is small. */
function overThresholdThenCompacted(afterId: string) {
  return (attempt: number) =>
    attempt === 1
      ? createResponse('resp-before-threshold', 800)
      : createResponse(afterId, 150);
}

function withSdkOptions<T extends { responses: object }>(client: T) {
  return Object.assign(client, {
    withOptions: vi.fn(() => client),
  });
}

function compactionActivityStates(
  handler: ModelHandlerOpenAIResponse,
): string[] {
  const logger = (handler as unknown as { logger: AgentTrace }).logger;
  return vi
    .mocked(logger.info)
    .mock.calls.flatMap(([, options]) =>
      options?.messageType === 'contextCompactionActivity'
        ? [(options.data as { state: string }).state]
        : [],
    );
}

function sendTurn(
  handler: ModelHandlerOpenAIResponse,
  client: unknown,
  messages: ResponseInputItem[],
  signal?: AbortSignal,
) {
  return handler.createResponse({
    client: client as any,
    messages,
    temperature: 0,
    signal,
  });
}

describe('ModelHandlerOpenAIResponse automatic compaction', () => {
  it('compacts before the next response when the live count crosses the threshold', async () => {
    const handler = createHandler();
    const requests: any[] = [];
    const compactRequests: any[] = [];
    const compactOptions: any[] = [];
    const compactedMessages = compactedState();
    const client = withSdkOptions({
      responses: {
        inputTokens: {
          // Turn 1 has nothing to compact (no prior response); turn 2
          // compacts off this live pre-flight count.
          count: OVER_THRESHOLD_COUNT,
        },
        compact: async (params: any, options: any) => {
          compactRequests.push(params);
          compactOptions.push(options);
          return {
            output: compactedMessages,
            usage: { output_tokens: 100 },
          };
        },
        create: recordCreate(
          requests,
          overThresholdThenCompacted('resp-after-compaction'),
        ),
      },
    });
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);
    const controller = new AbortController();

    await sendTurn(handler, client, firstTurnMessages);
    const result = await sendTurn(
      handler,
      client,
      secondTurnMessages,
      controller.signal,
    );

    expect(compactRequests).toHaveLength(1);
    expect(client.withOptions).toHaveBeenCalledWith({ maxRetries: 2 });
    expect(compactOptions[0]?.signal).toBe(controller.signal);
    expect(compactRequests[0].input).toEqual(secondTurnMessages);
    expect(requests).toHaveLength(2);
    expect(requests[1].previous_response_id).toBeUndefined();
    expect(requests[1].input).toEqual(compactedMessages);
    expect(result.updatedMessages).toEqual(compactedMessages);
    expect(compactionActivityStates(handler)).toEqual(['started', 'completed']);
  });

  it('mints a fresh ownership token for its own pre-flight compaction retry', async () => {
    // The flow clears its context-window recovery by token
    // (ResponseCycleNode's finally -> clearCompactionRequest(id)). A
    // compaction the handler requests for ITSELF must therefore carry a newer
    // token than any request the flow still holds, or that clear cancels the
    // handler's retry. Token ids are observable through requestCompaction()'s
    // return value: an internal request that bypassed the token API would
    // leave the counter untouched.
    const handler = createHandler();
    const compactedMessages = compactedState();
    const requests: any[] = [];
    const client = withSdkOptions({
      responses: {
        inputTokens: {
          count: OVER_THRESHOLD_COUNT,
        },
        compact: compactTo(compactedMessages),
        create: recordCreate(
          requests,
          overThresholdThenCompacted('resp-after-compaction'),
        ),
      },
    });

    await sendTurn(handler, client, createMessages(2));

    // A flow request that has already been abandoned; its id is the newest
    // token in existence at this point.
    const abandonedFlowToken = handler.requestCompaction();
    handler.clearCompactionRequest(abandonedFlowToken);

    // The live pre-flight count crosses the threshold, so the handler requests
    // compaction of itself and retries internally.
    await sendTurn(handler, client, createMessages(3));

    const nextFlowToken = handler.requestCompaction();
    expect(nextFlowToken).toBeGreaterThan(abandonedFlowToken + 1);
    expect(requests).toHaveLength(2);
    expect(requests[1].input).toEqual(compactedMessages);
  });

  it('stops the turn when Responses compaction is aborted', async () => {
    const handler = createHandler();
    const requests: any[] = [];
    const controller = new AbortController();
    const client = withSdkOptions({
      responses: {
        inputTokens: {
          count: OVER_THRESHOLD_COUNT,
        },
        compact: async () => {
          controller.abort();
          throw controller.signal.reason;
        },
        create: async (params: any) => {
          requests.push(params);
          return createResponse('resp-before-threshold', 800);
        },
      },
    });

    await sendTurn(handler, client, createMessages(2));
    await expect(
      sendTurn(handler, client, createMessages(3), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(requests).toHaveLength(1);
    expect(compactionActivityStates(handler)).toEqual(['started', 'cancelled']);
  });

  it('propagates an SDK user abort when the request signal is not aborted', async () => {
    const handler = createHandler();
    const abortError = new APIUserAbortError();
    const signal = new AbortController().signal;
    const client = withSdkOptions({
      responses: {
        inputTokens: { count: OVER_THRESHOLD_COUNT },
        compact: async () => Promise.reject(abortError),
        create: async () => createResponse('resp-before-threshold', 800),
      },
    });

    await sendTurn(handler, client, createMessages(2));
    await expect(
      sendTurn(handler, client, createMessages(3), signal),
    ).rejects.toBe(abortError);

    expect(signal.aborted).toBe(false);
    expect(compactionActivityStates(handler)).toEqual(['started', 'cancelled']);
  });

  it('marks failed and empty compact responses without claiming success', async () => {
    for (const [compact, expected] of [
      [async () => Promise.reject(new Error('compact failed')), 'failed'],
      [async () => ({ output: [], usage: { output_tokens: 0 } }), 'skipped'],
    ] as const) {
      const handler = createHandler();
      const client = withSdkOptions({
        responses: {
          inputTokens: { count: OVER_THRESHOLD_COUNT },
          compact,
          create: recordCreate([], (attempt) =>
            createResponse(`response-${attempt}`, attempt === 1 ? 800 : 150),
          ),
        },
      });

      await sendTurn(handler, client, createMessages(2));
      await sendTurn(handler, client, createMessages(3));

      expect(compactionActivityStates(handler)).toEqual(['started', expected]);
    }
  });

  it('reuses a successful compaction across a same-turn retry instead of re-compacting (chain-anchor/payload commit race)', async () => {
    // PocketFlow's Node._exec retries a failed exec() with the identical
    // prepRes, so a same-turn retry resends the exact same `messages` array
    // reference. Compaction's chain-anchor clear (on ServerChainState)
    // commits immediately and survives that retry permanently; its computed
    // payload (compactionResult) must now survive the same retry too, or the
    // retry silently redoes the compact() call for no reason.
    const handler = createHandler();
    const requests: any[] = [];
    const compactRequests: any[] = [];
    const compactedMessages = compactedState();
    const client = withSdkOptions({
      responses: {
        inputTokens: {
          // Over the 750-token threshold: turn 2's live count triggers the
          // compaction whose payload the same-turn retry must then reuse.
          count: OVER_THRESHOLD_COUNT,
        },
        compact: compactTo(compactedMessages, compactRequests),
        create: recordCreate(requests, (attempt) => {
          if (attempt === 1) {
            return createResponse('resp-before-threshold', 800);
          }
          if (attempt === 2) {
            // The request that follows a successful compaction fails once,
            // forcing a same-turn retry with the same `messages` reference.
            throw new Error('transient network failure');
          }
          return createResponse('resp-after-compaction', 150);
        }),
      },
    });
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);

    await sendTurn(handler, client, firstTurnMessages);

    await expect(sendTurn(handler, client, secondTurnMessages)).rejects.toThrow(
      'transient network failure',
    );

    // Same-turn retry: identical `messages` reference as the failed attempt.
    const result = await sendTurn(handler, client, secondTurnMessages);

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
    const compactedMessages = compactedState();
    let tokenCountCalls = 0;
    const client = withSdkOptions({
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
        compact: compactTo(compactedMessages, compactRequests),
        create: recordCreate(requests, (attempt) => {
          if (attempt === 1) return createResponse('resp-turn1', 800);
          if (attempt === 2) return createResponse('resp-turn2-compacted', 150);
          return createResponse('resp-turn3', 160);
        }),
      },
    });

    // One shared array, exactly as `shared.messages` is across the real
    // PocketFlow cycle.
    const sharedMessages = createMessages(2);

    // Turn 1: below threshold, no compaction.
    await sendTurn(handler, client, sharedMessages);

    // Turn 2 begins: a new message arrives, appended onto the SAME array
    // (mirrors ToolUseDispatchNode / a new user turn `.push()`-ing onto
    // `shared.messages`).
    const turn2NewMessage = { role: 'user', content: 'message 3' };
    sharedMessages.push(turn2NewMessage as ResponseInputItem);

    // Turn 2's live pre-flight count crosses the compaction threshold
    // (800 > 750), so turn 2 compacts.
    const turn2Result = await sendTurn(handler, client, sharedMessages);
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
    const turn3Result = await sendTurn(handler, client, sharedMessages);

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
    const client = withSdkOptions({
      responses: {
        inputTokens: {
          count: async () => ({ input_tokens: 100 }),
        },
        compact: compactTo(createMessages(1), compactRequests),
        create: recordCreate(requests, (attempt) =>
          attempt === 1
            ? createResponse('resp-before-threshold', 800)
            : createResponse('resp-without-compaction', 850),
        ),
      },
    });
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);

    await sendTurn(handler, client, firstTurnMessages);
    const result = await sendTurn(handler, client, secondTurnMessages);

    expect(compactRequests).toHaveLength(0);
    expect(requests).toHaveLength(2);
    expect(requests[1].previous_response_id).toBe('resp-before-threshold');
    expect(requests[1].input).toEqual([secondTurnMessages.at(-1)]);
    expect(result.updatedMessages).toBeUndefined();
  });

  it('leaves an OpenRouter-routed conversation uncompacted past the threshold', async () => {
    // OpenRouter conversations compact through ModelHandlerOpenRouterNative,
    // so this handler reports compaction unsupported on that route and must
    // never reach for /responses/compact — not even when the cumulative token
    // count is over the threshold. That capability gate fires before any
    // routing check inside shouldCompact(), which is why the skip needs no
    // log line (and no once-only flag to de-duplicate one).
    const handler = createOpenRouterRoutedHandler();
    const requests: any[] = [];
    const compactRequests: any[] = [];
    const client = withSdkOptions({
      responses: {
        compact: compactTo(createMessages(1), compactRequests),
        create: recordCreate(requests, (attempt) =>
          // 800 is over the 750-token threshold of the 1000-token window, so
          // a compaction-capable route would compact on the second turn.
          createResponse(`resp-${attempt}`, 800),
        ),
      },
    });

    await sendTurn(handler, client, createMessages(2));
    await sendTurn(handler, client, createMessages(3));

    expect(handler.supportsManualCompaction).toBe(false);
    expect(compactRequests).toHaveLength(0);
    expect(requests).toHaveLength(2);
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
    const client = withSdkOptions({
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
        create: recordCreate(requests, (attempt) => {
          if (attempt === 2) {
            tokensAfterDuringCall = (
              handler as unknown as {
                compactionResult?: { tokensAfter: number };
              }
            ).compactionResult?.tokensAfter;
          }
          return attempt === 1
            ? createResponse('resp-before-threshold', 800)
            : createResponse('resp-after-client-side-compaction', 150);
        }),
      },
    });
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);

    await sendTurn(handler, client, firstTurnMessages);
    const result = await sendTurn(handler, client, secondTurnMessages);

    // The stateful endpoint is never reached for this backend.
    expect(compactRequests).toHaveLength(0);

    // The client-side path summarizes via a throwaway streaming call.
    expect(streamRequests).toHaveLength(1);
    expect(client.withOptions).toHaveBeenCalledWith({ maxRetries: 2 });
    expect(streamRequests[0].instructions).toBe(COMPACTION_SYSTEM_PROMPT);
    expect(streamRequests[0].input).toEqual([
      ...secondTurnMessages,
      userTextMessage(COMPACTION_USER_PROMPT),
    ]);

    const resentText =
      '[Previous conversation summary]\n\nconcise summary of the prior turns';
    const expectedCompactedMessages = [userTextMessage(resentText)];
    expect(requests).toHaveLength(2);
    expect(requests[1].previous_response_id).toBeUndefined();
    expect(requests[1].input).toEqual(expectedCompactedMessages);
    expect(result.updatedMessages).toEqual(expectedCompactedMessages);

    // Issue 2: post-compaction bookkeeping must reflect the INPUT cost of
    // resending the compacted payload, not the summarization call's output
    // tokens (42). The Codex profile disables token counting, so this falls
    // back to a text-length estimate over exactly what gets resent.
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
    const client = withSdkOptions({
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
        create: recordCreate(requests, (attempt) =>
          attempt === 1
            ? createResponse('resp-before-threshold', 9000)
            : createResponse('resp-after-bounded-compaction', 150),
        ),
      },
    });

    await sendTurn(handler, client, createMessages(2));
    await sendTurn(handler, client, createMessages(3));

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
    const client = withSdkOptions({
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
        create: recordCreate(
          requests,
          overThresholdThenCompacted('resp-after-client-side-compaction'),
        ),
      },
    });

    await sendTurn(handler, client, createMessages(2));
    const result = await sendTurn(handler, client, createMessages(3));

    // Compaction happened (not skipped) and the resent summary is the streamed
    // text, not the empty finalResponse extraction.
    const expectedCompactedMessages = [
      userTextMessage(
        '[Previous conversation summary]\n\nstreamed summary from the deltas',
      ),
    ];
    expect(requests).toHaveLength(2);
    expect(requests[1].input).toEqual(expectedCompactedMessages);
    expect(result.updatedMessages).toEqual(expectedCompactedMessages);
  });
});
