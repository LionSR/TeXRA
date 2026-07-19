// Third-party imports
import { describe, it, expect, vi } from 'vitest';

// Local imports - class under test
import { noopTrace, type AgentTrace } from '@agent/trace';
import { AnthropicStreamHandler } from '@agent/modelHandlers/support/AnthropicStreamHandler';

// Type imports
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages';

/**
 * Builds a handler wired to a captured event callback, so tests can push
 * synthetic stream events without a real Anthropic SDK stream.
 */
function createHandlerHarness(progressViewEnabled: boolean) {
  const logger = {
    ...noopTrace,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    domain: vi.fn(),
    openStream: vi.fn(),
  };
  const handler = new AnthropicStreamHandler(
    logger as unknown as AgentTrace,
    { progressViewEnabled },
    {
      createThinkingStream: () =>
        ({ append: vi.fn(), finalize: vi.fn() }) as never,
      createOutputStream: () =>
        ({ append: vi.fn(), finalize: vi.fn() }) as never,
    },
  );

  let onStreamEvent: ((event: BetaRawMessageStreamEvent) => void) | undefined;
  handler.attachToStream({
    on: (eventName: string, cb: (event: BetaRawMessageStreamEvent) => void) => {
      if (eventName === 'streamEvent') onStreamEvent = cb;
    },
  } as never);

  const emit = (event: unknown) =>
    onStreamEvent?.(event as BetaRawMessageStreamEvent);

  return { logger, handler, emit };
}

/** Emits the server_tool_use + web_search_tool_result pair that triggers emission. */
function emitWebSearchSequence(emit: (event: unknown) => void) {
  emit({
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'server_tool_use',
      id: 'call_1',
      name: 'web_search',
      input: {},
    },
  });
  emit({
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 'call_1',
      content: [
        {
          type: 'web_search_result',
          url: 'https://example.com',
          title: 'Example',
          encrypted_content: 'enc',
          page_age: null,
        },
      ],
    },
  });
}

describe('AnthropicStreamHandler server-tool-result emission guard', () => {
  it('emits a webSearch domain event when the progress view is enabled', () => {
    const { logger, emit } = createHandlerHarness(true);

    emitWebSearchSequence(emit);

    expect(logger.domain).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'webSearch',
        data: expect.objectContaining({
          callId: 'call_1',
          status: 'completed',
        }),
      }),
    );
  });

  it('withholds the webSearch domain event when the progress view is disabled', () => {
    const { logger, emit } = createHandlerHarness(false);

    emitWebSearchSequence(emit);

    expect(logger.domain).not.toHaveBeenCalled();
  });
});
