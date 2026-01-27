/**
 * Dedicated stream handler for Anthropic responses.
 * Encapsulates the streaming event handling logic for improved testability and readability.
 */
// Third-party imports
import { z } from 'zod';
import {
  MESSAGE_TYPES,
  StreamDiagnosticsSchema,
  type StreamDiagnostics,
} from '@shared/schemas';
import {
  extractDomain,
  type WebSearchResult,
  type WebSearchResultEntry,
} from '@agent/modelHandlers/types/ServerToolTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResultBlock,
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
 * Maximum size for accumulated search input JSON (64KB).
 * Prevents memory growth for very long queries.
 */
const MAX_SEARCH_INPUT_SIZE = 65536;

/**
 * State tracked during Anthropic streaming.
 */
interface AnthropicStreamState {
  /** Current output stream for text blocks */
  outputStream: ReturnType<AgentLogger['createStream']> | null;
  /** Index of most recent block (any type) */
  lastBlockIndex: number;
  /** Track web search: tool_use_id → { index, accumulated input JSON } */
  pendingSearches: Map<string, { index: number; input: string }>;
  /** Track emitted search IDs to prevent duplicate logging in flow */
  emittedSearchIds: Set<string>;
  /** Flag to prevent processing events after finalize */
  finalized: boolean;
}

/**
 * Schema for internal mutable state during streaming.
 * Uses Set/timestamp fields for efficient tracking during stream processing.
 */
const StreamDiagnosticsStateSchema = z.object({
  /** Characters of thinking content received */
  thinkingChars: z.number(),
  /** Characters of text content received */
  textChars: z.number(),
  /** Characters of tool input JSON received */
  toolInputChars: z.number(),
  /** Total events processed */
  eventsProcessed: z.number(),
  /** Last event type (e.g., 'content_block_delta') */
  lastEventType: z.string().nullable(),
  /** Block types seen during streaming */
  blockTypesSeen: z.instanceof(Set<string>),
  /** Timestamp when streaming started */
  startTime: z.number(),
  /** Timestamp of last event received */
  lastEventTime: z.number(),
});

type StreamDiagnosticsState = z.infer<typeof StreamDiagnosticsStateSchema>;

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
  createThinkingStream: () => ReturnType<AgentLogger['createStream']>;
  createOutputStream: () => ReturnType<AgentLogger['createStream']>;
}

/**
 * Handles Anthropic streaming events with proper interleaved content block management.
 *
 * Streaming strategy for interleaved content blocks:
 * - Thinking blocks: each gets its own stream entry (separate thinking phases)
 * - Text blocks: consecutive text blocks merge, non-consecutive are separate
 * - Server tools (web_search): emit to progress view when results arrive
 *
 * Example: text_0 → server_tool_1 → result_2 → text_3 → text_4
 *   → Output #1 (text_0), WebSearch, Output #2 (text_3 + text_4 merged)
 */
export class AnthropicStreamHandler {
  private readonly thinkingStreams = new Map<
    number,
    ReturnType<AgentLogger['createStream']>
  >();
  private readonly state: AnthropicStreamState = {
    outputStream: null,
    lastBlockIndex: -1,
    pendingSearches: new Map(),
    emittedSearchIds: new Set(),
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
  };

  constructor(
    private readonly logger: AgentLogger,
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
    this.state.emittedSearchIds.clear();
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

    if (blockType === 'thinking') {
      // Finalize any pending text stream before starting thinking
      this.finalizeOutputStream();
      this.thinkingStreams.set(
        blockIndex,
        this.factories.createThinkingStream(),
      );
    } else if (blockType === 'text' && this.config.outputEnabled) {
      // Consecutive text blocks share a stream
      // Consecutive means: immediately following (by index) AND previous was text
      // The outputStream !== null check ensures previous block was text
      // (we null it for thinking/tool blocks)
      const isConsecutive =
        this.state.outputStream !== null &&
        blockIndex === this.state.lastBlockIndex + 1;

      if (!isConsecutive) {
        // First text block or non-consecutive - create new stream
        this.finalizeOutputStream();
        this.state.outputStream = this.factories.createOutputStream();
      }
    } else if (blockType === 'server_tool_use') {
      // Track web search server tool use to get query
      const block = event.content_block as ServerToolUseBlock;
      if (block.name === 'web_search') {
        this.state.pendingSearches.set(block.id, {
          index: blockIndex,
          input: '',
        });
      }
      // Finalize any pending text stream
      this.finalizeOutputStream();
    } else if (blockType === 'web_search_tool_result') {
      this.handleWebSearchResult(
        event.content_block as WebSearchToolResultBlock,
      );
      // Finalize any pending text stream
      this.finalizeOutputStream();
    } else {
      // Other non-text, non-thinking blocks (tool_use, etc.)
      // Finalize any pending text stream
      this.finalizeOutputStream();
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
        // Accumulate input JSON for web search to get query (with size limit)
        for (const [, searchData] of this.state.pendingSearches) {
          if (searchData.index === event.index) {
            // Apply size limit to prevent memory growth
            if (searchData.input.length < MAX_SEARCH_INPUT_SIZE) {
              const remaining = MAX_SEARCH_INPUT_SIZE - searchData.input.length;
              searchData.input += event.delta.partial_json.slice(0, remaining);
            }
            break;
          }
        }
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
   * Parses the search query from accumulated input JSON.
   */
  private parseSearchQuery(input: string | undefined): string {
    if (!input) {
      return '';
    }

    try {
      const parsed = JSON.parse(input) as { query?: string };
      return parsed.query ?? '';
    } catch (error) {
      // Partial JSON (common for streaming), try to extract query with regex
      this.logger.debug(
        `Anthropic search input JSON parse failed, using regex fallback: ${String(error)}`,
      );
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
    const entries: WebSearchResultEntry[] = [];

    if (Array.isArray(block.content)) {
      for (const item of block.content) {
        const r = item as WebSearchResultBlock;
        if (r.type === 'web_search_result' && r.url) {
          entries.push({
            url: r.url,
            title: r.title,
            snippet: r.encrypted_content,
            pageAge: r.page_age ?? undefined,
            domain: extractDomain(r.url),
          });
        }
      }
    }

    return entries;
  }

  /**
   * Finalizes the output stream if present and clears it.
   */
  private finalizeOutputStream(): void {
    if (this.state.outputStream) {
      this.state.outputStream.finalize();
      this.state.outputStream = null;
    }
  }

  /**
   * Emits a web search result to the progress view.
   */
  private emitWebSearchResult(result: WebSearchResult): void {
    if (!this.config.progressViewEnabled) {
      return;
    }
    this.logger.logWebSearch(result);
  }
}
