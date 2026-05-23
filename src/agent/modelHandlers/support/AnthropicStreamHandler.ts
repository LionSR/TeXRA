/**
 * Dedicated stream handler for Anthropic responses.
 * Encapsulates the streaming event handling logic for improved testability and readability.
 */
// Third-party imports
import type { AgentTrace } from '@agent/trace';
import {
  extractDomain,
  type WebFetchResult,
  type WebSearchResult,
  type WebSearchResultEntry,
} from '@agent/modelHandlers/types/ServerToolTypes';
import { MESSAGE_TYPES, type StreamDiagnostics } from '@shared/schemas';
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResultBlock,
  WebFetchToolResultBlock,
  WebFetchBlock,
} from '@anthropic-ai/sdk/resources/messages';

/**
 * Duck-typed interface for Anthropic message streams.
 * Allows us to work with the stream without importing SDK-internal types.
 */
interface AnthropicMessageStream {
  on(
    event: 'streamEvent',
    callback: (event: BetaRawMessageStreamEvent) => void,
  ): void;
}

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
  outputStream: ReturnType<AgentTrace['createStream']> | null;
  /** Index of most recent block (any type) */
  lastBlockIndex: number;
  /** Track web search: tool_use_id → { index, accumulated input JSON } */
  pendingSearches: Map<string, { index: number; input: string }>;
  /** Track web fetch: tool_use_id → { index, accumulated input JSON } */
  pendingFetches: Map<string, { index: number; input: string }>;
  /** Track emitted search IDs to prevent duplicate logging in flow */
  emittedSearchIds: Set<string>;
  /** Track emitted fetch IDs to prevent duplicate logging in flow */
  emittedFetchIds: Set<string>;
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
  /** Whether output streaming is enabled */
  outputEnabled: boolean;
  /** Whether progress view is enabled */
  progressViewEnabled: boolean;
}

/**
 * Factory functions for creating streams.
 */
interface StreamFactories {
  createThinkingStream: () => ReturnType<AgentTrace['createStream']>;
  createOutputStream: () => ReturnType<AgentTrace['createStream']>;
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
  private readonly thinkingStreams = new Map<
    number,
    ReturnType<AgentTrace['createStream']>
  >();
  private readonly state: AnthropicStreamState = {
    outputStream: null,
    lastBlockIndex: -1,
    pendingSearches: new Map(),
    pendingFetches: new Map(),
    emittedSearchIds: new Set(),
    emittedFetchIds: new Set(),
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
   * Gets the set of emitted search IDs for duplicate prevention in flow.
   */
  getEmittedSearchIds(): Set<string> {
    return this.state.emittedSearchIds;
  }

  /**
   * Gets the set of emitted fetch IDs for duplicate prevention in flow.
   */
  getEmittedFetchIds(): Set<string> {
    return this.state.emittedFetchIds;
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
   * Call this after stream.finalMessage() completes.
   * Sets finalized flag to prevent processing any subsequent events.
   */
  finalize(): void {
    // Set flag first to prevent processing any events that arrive during cleanup
    this.state.finalized = true;

    // Finalize any remaining thinking streams
    for (const s of this.thinkingStreams.values()) {
      s.finalize();
    }
    this.thinkingStreams.clear();

    // Finalize output stream
    this.state.outputStream?.finalize();
    this.state.outputStream = null;

    // Clear state to prevent memory leaks
    this.state.pendingSearches.clear();
    this.state.pendingFetches.clear();
    this.state.emittedSearchIds.clear();
    this.state.emittedFetchIds.clear();
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
        this.diagnostics.anthropicMessageId =
          (event.message as { id?: string })?.id ?? null;
        break;
      case 'message_delta':
        this.diagnostics.stopReason =
          (event.delta as { stop_reason?: string | null })?.stop_reason ?? null;
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
      this.config.outputEnabled &&
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
      this.logger.debug('Compaction block started in stream');
    } else if (blockType === 'text' && this.config.outputEnabled) {
      if (!isConsecutiveText) {
        this.state.outputStream = this.factories.createOutputStream();
      }
    } else if (blockType === 'server_tool_use') {
      const block = event.content_block as ServerToolUseBlock;
      if (block.name === 'web_search') {
        this.state.pendingSearches.set(block.id, {
          index: blockIndex,
          input: '',
        });
      } else if (block.name === 'web_fetch') {
        this.state.pendingFetches.set(block.id, {
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
      case 'compaction_delta':
        // Compaction content arrives as a single summary delta and is not user-visible output.
        this.logger.debug(
          `Compaction summary delta received (${event.delta.content?.length ?? 0} chars)`,
        );
        break;
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
    const searchData = this.state.pendingSearches.get(block.tool_use_id);

    // Parse query from accumulated input JSON
    const query = this.parseSearchQuery(searchData?.input);

    // Extract results from the block content
    const entries = this.extractSearchResults(block);

    // Emit to progress view
    if (entries.length > 0 || query) {
      this.emitWebSearchResult({
        query,
        results: entries,
        provider: 'anthropic',
        callId: block.tool_use_id,
        status: 'completed',
      });
      this.state.emittedSearchIds.add(block.tool_use_id);
    }

    // Clean up
    this.state.pendingSearches.delete(block.tool_use_id);
  }

  /**
   * Handles web_fetch_tool_result blocks.
   */
  private handleWebFetchResult(block: WebFetchToolResultBlock): void {
    const fetchData = this.state.pendingFetches.get(block.tool_use_id);

    // Parse URL from accumulated input JSON
    const fetchUrl = this.parseFetchUrl(fetchData?.input);

    // Determine if fetch succeeded or failed
    const isSuccess =
      typeof block.content === 'object' &&
      block.content !== null &&
      block.content.type === 'web_fetch_result';

    const result: WebFetchResult = isSuccess
      ? {
          url: (block.content as WebFetchBlock).url || fetchUrl,
          title: (block.content as WebFetchBlock).content?.title ?? undefined,
          provider: 'anthropic',
          callId: block.tool_use_id,
          status: 'completed',
        }
      : {
          url: fetchUrl,
          provider: 'anthropic',
          callId: block.tool_use_id,
          status: 'failed',
          errorCode: (block.content as { error_code?: string }).error_code,
        };

    // Emit to progress view
    if (result.url || result.status === 'failed') {
      this.emitWebFetchResult(result);
      this.state.emittedFetchIds.add(block.tool_use_id);
    }

    // Clean up
    this.state.pendingFetches.delete(block.tool_use_id);
  }

  /**
   * Accumulates input JSON for pending server tool calls (web search and web fetch).
   * Applies a size limit to prevent memory growth.
   */
  private accumulateServerToolInput(
    blockIndex: number,
    partialJson: string,
  ): void {
    // Check both pending searches and pending fetches
    for (const pendingMap of [
      this.state.pendingSearches,
      this.state.pendingFetches,
    ]) {
      for (const [, data] of pendingMap) {
        if (data.index === blockIndex) {
          if (data.input.length < MAX_SERVER_TOOL_INPUT_SIZE) {
            const remaining = MAX_SERVER_TOOL_INPUT_SIZE - data.input.length;
            data.input += partialJson.slice(0, remaining);
          }
          return;
        }
      }
    }
  }

  /**
   * Parses the fetch URL from accumulated input JSON.
   */
  private parseFetchUrl(input: string | undefined): string {
    if (!input) return '';

    try {
      const parsed = JSON.parse(input) as { url?: string };
      return parsed.url ?? '';
    } catch {
      // Partial JSON (common for streaming), try to extract URL with regex
      const match = input.match(/"url"\s*:\s*"([^"]+)"/);
      return match?.[1] ?? '';
    }
  }

  /**
   * Parses the search query from accumulated input JSON.
   */
  private parseSearchQuery(input: string | undefined): string {
    if (!input) return '';

    try {
      const parsed = JSON.parse(input) as { query?: string };
      return parsed.query ?? '';
    } catch {
      // Partial JSON (common for streaming), try to extract query with regex
      const match = input.match(/"query"\s*:\s*"([^"]+)"/);
      return match?.[1] ?? '';
    }
  }

  /**
   * Extracts search results from a web_search_tool_result block.
   */
  private extractSearchResults(
    block: WebSearchToolResultBlock,
  ): WebSearchResultEntry[] {
    if (!Array.isArray(block.content)) return [];

    return (block.content as WebSearchResultBlock[])
      .filter((r) => r.type === 'web_search_result' && r.url)
      .map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.encrypted_content,
        pageAge: r.page_age ?? undefined,
        domain: extractDomain(r.url),
      }));
  }

  /**
   * Finalizes the output stream if present and clears it.
   */
  private finalizeOutputStream(): void {
    this.state.outputStream?.finalize();
    this.state.outputStream = null;
  }

  /**
   * Emits a web search result to the progress view.
   */
  private emitWebSearchResult(result: WebSearchResult): void {
    if (this.config.progressViewEnabled) {
      this.logger.logWebSearch(result);
    }
  }

  /**
   * Emits a web fetch result to the progress view.
   */
  private emitWebFetchResult(result: WebFetchResult): void {
    if (this.config.progressViewEnabled) {
      this.logger.logWebFetch(result);
    }
  }
}
