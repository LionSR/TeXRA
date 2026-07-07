// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent model handlers
import type { AgentTrace } from '@agent/trace';
import {
  CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
  estimateTokensFromText,
} from '@agent/modelHandlers/contextManagementConstants';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import type { ProviderCapabilityProfile } from '@model/providerCapabilities';

// Type imports
import type { ResponseInputItem } from 'openai/resources/responses/responses';

function createLoggerStub(): Partial<AgentTrace> & { streamId: string } {
  return {
    streamId: 'test-channel',
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    domain: vi.fn(),
  };
}

function createConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'gpt-4.1',
    fullName: 'gpt-4.1',
    shortName: 'gpt-4.1',
    label: 'GPT 4.1',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: overrides.maxOutputTokens ?? 100,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: overrides.contextWindow ?? 1000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning: false,
      supportsVision: false,
      ...(overrides.capabilities ?? {}),
    },
    openRouterOnly: overrides.openRouterOnly ?? false,
  };
}

function configureHandler(
  handler: ModelHandlerOpenAIResponse,
): ModelHandlerOpenAIResponse {
  handler.setLogger(createLoggerStub() as unknown as AgentTrace);
  (handler as { getStreamingConfig: () => boolean }).getStreamingConfig = () =>
    false;
  return handler;
}

function createHandler(): ModelHandlerOpenAIResponse {
  return configureHandler(new ModelHandlerOpenAIResponse(createConfig()));
}

class UnsupportedCompactionHandler extends ModelHandlerOpenAIResponse {
  override get supportsManualCompaction(): boolean {
    return false;
  }
}

function createUnsupportedCompactionHandler(): ModelHandlerOpenAIResponse {
  return configureHandler(new UnsupportedCompactionHandler(createConfig()));
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
      createConfig({ contextWindow }),
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
  it('compacts before the next response when prior usage crosses the threshold', async () => {
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
          count: async () => ({ input_tokens: 100 }),
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
    expect(streamRequests[0].input).toEqual(secondTurnMessages);

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
    const compactionResult = (
      handler as unknown as {
        compactionResult?: { tokensAfter: number };
      }
    ).compactionResult;
    expect(compactionResult?.tokensAfter).toBe(
      estimateTokensFromText(resentText),
    );
    expect(compactionResult?.tokensAfter).not.toBe(42);
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
});
