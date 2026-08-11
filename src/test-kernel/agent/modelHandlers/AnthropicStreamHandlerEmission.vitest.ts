import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages';
import { describe, expect, it, vi } from 'vitest';

import { noopTrace, type AgentTrace } from '@agent/trace';
import { AnthropicStreamHandler } from '@agent/modelHandlers/support/AnthropicStreamHandler';

/**
 * Builds a handler wired to a captured event callback, so tests can push
 * synthetic stream events without a real Anthropic SDK stream.
 */
function createHandlerHarness(progressViewEnabled: boolean) {
  // Only `info` (compaction activity) and `domain` (server-tool results) are
  // asserted; the remaining AgentTrace methods stay no-op via noopTrace.
  const logger = {
    ...noopTrace,
    info: vi.fn(),
    domain: vi.fn(),
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

describe('AnthropicStreamHandler compaction activity', () => {
  it('coalesces active blocks and terminalizes at the enclosing stream outcome', () => {
    const { logger, handler, emit } = createHandlerHarness(true);

    emit({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'compaction', content: '' },
    });
    emit({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'compaction', content: '' },
    });
    const operationId = logger.info.mock.calls[0]?.[1]?.data.operationId;

    emit({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'compaction_delta', content: 'usable summary' },
    });
    emit({ type: 'content_block_stop', index: 0 });
    emit({ type: 'content_block_stop', index: 1 });
    expect(logger.info).toHaveBeenCalledTimes(1);

    handler.finalize('completed');
    handler.finalize('failed');

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info.mock.calls.map(([, options]) => options.data)).toEqual([
      {
        activity: 'context_compaction',
        operationId,
        state: 'started',
      },
      {
        activity: 'context_compaction',
        operationId,
        state: 'completed',
      },
    ]);
  });

  it.each(['failed', 'cancelled', 'skipped'] as const)(
    'preserves the canonical %s outcome',
    (outcome) => {
      const { logger, handler, emit } = createHandlerHarness(true);
      emit({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'compaction', content: '' },
      });

      handler.finalize(outcome);

      expect(logger.info.mock.calls.at(-1)?.[1]?.data).toMatchObject({
        state: outcome,
      });
    },
  );
});
