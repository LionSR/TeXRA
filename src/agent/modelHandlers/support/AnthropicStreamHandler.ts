/**
 * Dedicated stream handler for Anthropic responses.
 * Encapsulates the streaming event handling logic for improved testability and readability.
 */
// Third-party imports
import {
  logWebFetch,
  startCompactionActivity,
  type AgentTrace,
  type CompactionActivityOperation,
} from '@agent/trace';
import {
  extractWebFetchResultFields,
  mapAnthropicWebSearchEntries,
  type WebFetchResult,
} from '@agent/types/ServerToolTypes';
import { safeParseJson } from '@common/parsing/safeParseJson';
import type {
  CompactionActivityOutcome,
  StreamDiagnostics,
} from '@shared/schemas';
import { emitServerToolResult } from './serverToolResultEmission';
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages';
// BetaMessageStream is only exported from lib/ — not re-exported from the SDK's
// public resources/ entry point. The BetaMessageStream class is what
// client.beta.messages.stream() returns, and ./lib/* is in the SDK's exports
// map, so this import is semantically correct even if the path is less stable.
import type { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream';
import type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebFetchToolResultBlock,
} from '@anthropic-ai/sdk/resources/messages';

/**
 * Minimal stream interface derived from the Anthropic SDK's BetaMessageStream.
 * Accepts any stream with the same typed `.on()` method — callers pass the
 * SDK's BetaMessageStream directly; tests pass a compatible stub.
 */
type AnthropicMessageStream = Pick<BetaMessageStream, 'on'>;

/**
 * Maximum size for accumulated server tool input JSON (64KB).
 * Prevents memory growth for very long queries/URLs.
 */
const MAX_SERVER_TOOL_INPUT_SIZE = 65536;

/**
 * State tracked during Anthropic streaming.
 */
interface AnthropicStreamState {
  /** Current output stream for text blocks */
  outputStream: ReturnType<AgentTrace['openStream']> | null;
  /** Index of most recent block (any type) */
  lastBlockIndex: number;
  /**
   * Track pending server tools (web search, web fetch):
   * tool_use_id → { index, accumulated input JSON }. Ids are unique across
   * tool kinds, so both share one map.
   */
  pendingServerTools: Map<string, { index: number; input: string }>;
  /** Flag to prevent processing events after finalize */
  finalized: boolean;
}

/**
 * Internal mutable state during streaming.
 * Shares counter/flag fields with {@link StreamDiagnostics} but uses
 * runtime-efficient types (Set, timestamps) that getDiagnostics() converts
 * to the serializable output form.
 */
interface StreamDiagnosticsState extends Omit<
  StreamDiagnostics,
  'blockTypesSeen' | 'elapsedSecs' | 'secsSinceLastEvent' | 'finalized'
> {
  /** Block types seen during streaming (converted to array in getDiagnostics) */
  blockTypesSeen: Set<string>;
  /** Timestamp when streaming started (converted to elapsedSecs) */
  startTime: number;
  /** Timestamp of last event received (converted to secsSinceLastEvent) */
  lastEventTime: number;
}

/**
 * Configuration for the stream handler.
 */
interface StreamHandlerConfig {
  /** Whether progress view is enabled */
  progressViewEnabled: boolean;
}

/**
 * Factory functions for creating streams.
 */
interface StreamFactories {
  createThinkingStream: () => ReturnType<AgentTrace['openStream']>;
  createOutputStream: () => ReturnType<AgentTrace['openStream']>;
}

/**
 * Handles Anthropic streaming events with proper interleaved content block management.
 *
 * Streaming strategy for interleaved content blocks:
 * - Thinking blocks: each gets its own stream entry (separate thinking phases)
 * - Text blocks: consecutive text blocks merge, non-consecutive are separate
 * - Server tools (web_search, web_fetch): emit to progress view when results arrive
 *
 * Example: text_0 → server_tool_1 → result_2 → text_3 → text_4
 *   → Output #1 (text_0), WebSearch/WebFetch, Output #2 (text_3 + text_4 merged)
 */
export class AnthropicStreamHandler {
  private compactionActivity: CompactionActivityOperation | undefined;
  private readonly thinkingStreams = new Map<
    number,
    ReturnType<AgentTrace['openStream']>
  >();
  private readonly state: AnthropicStreamState = {
    outputStream: null,
    lastBlockIndex: -1,
    pendingServerTools: new Map(),
    finalized: false,
  };
  private readonly diagnostics: StreamDiagnosticsState = {
    thinkingChars: 0,
    textChars: 0,
    toolInputChars: 0,
    blockTypesSeen: new Set(),
    eventsProcessed: 0,
    lastEventType: null,
    startTime: Date.now(),
    lastEventTime: Date.now(),
    messageStartReceived: false,
    messageStopReceived: false,
    stopReason: null,
    anthropicMessageId: null,
  };

  constructor(
    private readonly logger: AgentTrace,
    private readonly config: StreamHandlerConfig,
    private readonly factories: StreamFactories,
  ) {}

  /**
   * Attaches event listeners to the stream and returns the handler for cleanup.
   */
  attachToStream(stream: AnthropicMessageStream): void {
    stream.on('streamEvent', (event: BetaRawMessageStreamEvent) => {
      this.handleStreamEvent(event);
    });
  }

  /**
   * Returns diagnostic information about the streaming state.
   * Useful for debugging stream failures - shows what was received before error.
   */
  getDiagnostics(): StreamDiagnostics {
    const now = Date.now();
    return {
      thinkingChars: this.diagnostics.thinkingChars,
      textChars: this.diagnostics.textChars,
      toolInputChars: this.diagnostics.toolInputChars,
      blockTypesSeen: [...this.diagnostics.blockTypesSeen],
      eventsProcessed: this.diagnostics.eventsProcessed,
      lastEventType: this.diagnostics.lastEventType,
      elapsedSecs: Math.round((now - this.diagnostics.startTime) / 1000),
      secsSinceLastEvent: Math.round(
        (now - this.diagnostics.lastEventTime) / 1000,
      ),
      finalized: this.state.finalized,
      messageStartReceived: this.diagnostics.messageStartReceived,
      messageStopReceived: this.diagnostics.messageStopReceived,
      stopReason: this.diagnostics.stopReason,
      anthropicMessageId: this.diagnostics.anthropicMessageId,
    };
  }

  /**
   * Finalizes all remaining streams and clears state.
   * Call this with the canonical final-response compaction outcome.
   * Sets finalized flag to prevent processing any subsequent events.
   */
  finalize(compactionOutcome: CompactionActivityOutcome): void {
    if (this.state.finalized) return;
    // Set flag first to prevent processing any events that arrive during cleanup
    this.state.finalized = true;

    // Finalize any remaining thinking streams
    for (const s of this.thinkingStreams.values()) {
      s.finalize();
    }
    this.thinkingStreams.clear();

    this.compactionActivity?.finish(compactionOutcome);

    // Finalize output stream
    this.state.outputStream?.finalize();
    this.state.outputStream = null;

    // Clear state to prevent memory leaks
    this.state.pendingServerTools.clear();
  }

  /**
   * Handles a single stream event.
   * Ignores events if handler has been finalized.
   */
  private handleStreamEvent(event: BetaRawMessageStreamEvent): void {
    // Ignore events after finalization to prevent processing stale events
    if (this.state.finalized) return;

    // Track diagnostic metrics for all events
    this.diagnostics.eventsProcessed++;
    this.diagnostics.lastEventType = event.type;
    this.diagnostics.lastEventTime = Date.now();

    switch (event.type) {
      case 'message_start':
        this.diagnostics.messageStartReceived = true;
        this.diagnostics.anthropicMessageId = event.message.id;
        break;
      case 'message_delta':
        this.diagnostics.stopReason = event.delta.stop_reason;
        break;
      case 'message_stop':
        this.diagnostics.messageStopReceived = true;
        break;
      case 'content_block_start':
        this.handleBlockStart(event);
        break;
      case 'content_block_delta':
        this.handleBlockDelta(event);
        break;
      case 'content_block_stop':
        this.handleBlockStop(event);
        break;
    }
  }

  /**
   * Handles content_block_start events.
   */
  private handleBlockStart(
    event: Extract<BetaRawMessageStreamEvent, { type: 'content_block_start' }>,
  ): void {
    const blockType = event.content_block.type;
    const blockIndex = event.index;

    // Track block type for diagnostics
    this.diagnostics.blockTypesSeen.add(blockType);

    // Check for consecutive text blocks that share a stream.
    // Consecutive means: immediately following (by index) AND previous was text.
    // The outputStream !== null check ensures previous block was text
    // (we null it for thinking/tool blocks).
    const isConsecutiveText =
      blockType === 'text' &&
      this.state.outputStream !== null &&
      blockIndex === this.state.lastBlockIndex + 1;

    // Finalize pending text stream for all non-consecutive cases
    if (!isConsecutiveText) {
      this.finalizeOutputStream();
    }

    if (blockType === 'thinking') {
      this.thinkingStreams.set(
        blockIndex,
        this.factories.createThinkingStream(),
      );
    } else if (blockType === 'compaction') {
      this.compactionActivity ??= startCompactionActivity(this.logger);
      this.logger.debug('Compaction block started in stream');
    } else if (blockType === 'text') {
      if (!isConsecutiveText) {
        this.state.outputStream = this.factories.createOutputStream();
      }
    } else if (blockType === 'server_tool_use') {
      const block = event.content_block as ServerToolUseBlock;
      if (block.name === 'web_search' || block.name === 'web_fetch') {
        this.state.pendingServerTools.set(block.id, {
          index: blockIndex,
          input: '',
        });
      }
    } else if (blockType === 'web_search_tool_result') {
      this.handleWebSearchResult(
        event.content_block as WebSearchToolResultBlock,
      );
    } else if (blockType === 'web_fetch_tool_result') {
      this.handleWebFetchResult(event.content_block as WebFetchToolResultBlock);
    }

    // Always update lastBlockIndex for ALL block types
    this.state.lastBlockIndex = blockIndex;
  }

  /**
   * Handles content_block_delta events.
   */
  private handleBlockDelta(
    event: Extract<BetaRawMessageStreamEvent, { type: 'content_block_delta' }>,
  ): void {
    switch (event.delta.type) {
      case 'thinking_delta':
        this.diagnostics.thinkingChars += event.delta.thinking.length;
        this.thinkingStreams.get(event.index)?.append(event.delta.thinking);
        break;
      case 'text_delta':
        this.diagnostics.textChars += event.delta.text.length;
        this.state.outputStream?.append(event.delta.text);
        break;
      case 'input_json_delta':
        this.diagnostics.toolInputChars += event.delta.partial_json.length;
        // Accumulate input JSON for server tools to extract query/URL (with size limit)
        this.accumulateServerToolInput(event.index, event.delta.partial_json);
        break;
      case 'compaction_delta': {
        // Compaction content is not user-visible output. The final response is
        // the authority for whether the summary is usable.
        const contentLength = event.delta.content?.trim().length ?? 0;
        this.logger.debug(
          `Compaction summary delta received (${contentLength} chars)`,
        );
        break;
      }
    }
  }

  /**
   * Handles content_block_stop events.
   */
  private handleBlockStop(
    event: Extract<BetaRawMessageStreamEvent, { type: 'content_block_stop' }>,
  ): void {
    // Finalize thinking streams immediately on block stop
    const thinking = this.thinkingStreams.get(event.index);
    if (thinking) {
      thinking.finalize();
      this.thinkingStreams.delete(event.index);
    }
    // Text streams: don't finalize here - wait for non-text block or end
  }

  /**
   * Handles web_search_tool_result blocks.
   */
  private handleWebSearchResult(block: WebSearchToolResultBlock): void {
    const query = this.takePendingInputField(block.tool_use_id, 'query');

    // Extract results from the block content
    const entries = mapAnthropicWebSearchEntries(block.content);

    // Emit to progress view
    if (entries.length > 0 || query) {
      emitServerToolResult(this.logger, this.config.progressViewEnabled, {
        query,
        results: entries,
        provider: 'anthropic',
        callId: block.tool_use_id,
        status: 'completed',
      });
    }
  }

  /**
   * Handles web_fetch_tool_result blocks.
   */
  private handleWebFetchResult(block: WebFetchToolResultBlock): void {
    const fetchUrl = this.takePendingInputField(block.tool_use_id, 'url');

    // Native discriminated-union narrowing on block.content
    // (WebFetchBlock | WebFetchToolResultErrorBlock) replaces the prior
    // structural casts.
    const fields = extractWebFetchResultFields(block);
    const result: WebFetchResult =
      block.content.type === 'web_fetch_result'
        ? {
            url: fields?.url || fetchUrl,
            title: fields?.title,
            provider: 'anthropic',
            callId: block.tool_use_id,
            status: 'completed',
            content: fields?.content,
          }
        : {
            url: fetchUrl,
            provider: 'anthropic',
            callId: block.tool_use_id,
            status: 'failed',
            errorCode: block.content.error_code,
          };

    // Emit to progress view
    if (
      (result.url || result.status === 'failed') &&
      this.config.progressViewEnabled
    ) {
      logWebFetch(this.logger, result);
    }
  }

  /**
   * Accumulates input JSON for pending server tool calls (web search and web fetch).
   * Applies a size limit to prevent memory growth.
   */
  private accumulateServerToolInput(
    blockIndex: number,
    partialJson: string,
  ): void {
    for (const data of this.state.pendingServerTools.values()) {
      if (data.index === blockIndex) {
        if (data.input.length < MAX_SERVER_TOOL_INPUT_SIZE) {
          const remaining = MAX_SERVER_TOOL_INPUT_SIZE - data.input.length;
          data.input += partialJson.slice(0, remaining);
        }
        return;
      }
    }
  }

  /**
   * Consume a pending server tool's accumulated input JSON and extract a single
   * string field from it. Falls back to regex for the partial JSON common
   * during streaming.
   */
  private takePendingInputField(toolUseId: string, field: string): string {
    const input = this.state.pendingServerTools.get(toolUseId)?.input;
    this.state.pendingServerTools.delete(toolUseId);
    if (!input) return '';
    const parsed = safeParseJson(input);
    if (parsed.isOk())
      return (parsed.value as Record<string, string>)[field] ?? '';
    const match = input.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
    return match?.[1] ?? '';
  }

  /**
   * Finalizes the output stream if present and clears it.
   */
  private finalizeOutputStream(): void {
    this.state.outputStream?.finalize();
    this.state.outputStream = null;
  }
}
