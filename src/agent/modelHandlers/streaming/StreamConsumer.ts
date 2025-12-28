/**
 * Stream consumer for unified streaming events.
 *
 * This class consumes normalized stream events and handles:
 * - Creating and managing thinking/output streams via AgentLogger
 * - Handling interleaved content blocks (Anthropic)
 * - Emitting web search results to progress view
 * - Accumulating tool calls
 * - Error handling and cleanup
 *
 * Usage:
 * ```typescript
 * const consumer = new StreamConsumer(logger, options);
 * const response = await consumer.consume(normalizedStream);
 * ```
 */

import type { AgentLogger, AgentLogStream } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

import type {
  StreamEvent,
  NormalizedResponse,
  ThinkingEvent,
  ContentEvent,
  WebSearchEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallDoneEvent,
  UsageEvent,
  DoneEvent,
} from './streamEventSchema';
import type { StreamConsumerOptions, StreamConsumptionResult } from './types';

/**
 * Internal state for stream consumption.
 */
interface ConsumerState {
  // Streams
  thinkingStream: AgentLogStream | null;
  outputStream: AgentLogStream | null;

  // Block tracking (for interleaved content)
  currentThinkingBlockIndex: number;
  currentContentBlockIndex: number;

  // Accumulation
  thinkingBuffer: string;
  contentBuffer: string;

  // Tool calls
  toolCalls: Map<
    string,
    {
      id: string;
      name: string;
      arguments: string;
    }
  >;

  // Web search deduplication
  emittedWebSearchIds: Set<string>;

  // Final response from done event
  finalResponse: NormalizedResponse | null;

  // Metrics
  hadThinking: boolean;
  hadContent: boolean;
  webSearchCount: number;
}

/**
 * Stream consumer that processes normalized events and manages UI streams.
 */
export class StreamConsumer {
  private readonly logger: AgentLogger;
  private readonly options: StreamConsumerOptions;

  constructor(
    logger: AgentLogger,
    options: Partial<StreamConsumerOptions> = {},
  ) {
    this.logger = logger;
    this.options = {
      thinkingEnabled: options.thinkingEnabled ?? true,
      outputEnabled: options.outputEnabled ?? true,
      progressViewEnabled: options.progressViewEnabled ?? true,
      handleInterleavedBlocks: options.handleInterleavedBlocks ?? false,
      logger,
    };
  }

  /**
   * Consume a normalized stream and return the final response.
   *
   * @param stream - Async iterable of normalized stream events
   * @returns Promise resolving to the final response
   */
  async consume(
    stream: AsyncIterable<StreamEvent>,
  ): Promise<StreamConsumptionResult> {
    const state = this.createInitialState();

    try {
      for await (const event of stream) {
        this.handleEvent(event, state);
      }

      // Finalize any open streams
      this.finalizeStreams(state);

      // Return result with accumulated data
      return this.buildResult(state);
    } catch (error) {
      // Ensure streams are finalized on error
      this.finalizeStreams(state);
      throw error;
    }
  }

  /**
   * Create initial consumer state.
   */
  private createInitialState(): ConsumerState {
    return {
      thinkingStream: null,
      outputStream: null,
      currentThinkingBlockIndex: -1,
      currentContentBlockIndex: -1,
      thinkingBuffer: '',
      contentBuffer: '',
      toolCalls: new Map(),
      emittedWebSearchIds: new Set(),
      finalResponse: null,
      hadThinking: false,
      hadContent: false,
      webSearchCount: 0,
    };
  }

  /**
   * Handle a single stream event.
   */
  private handleEvent(event: StreamEvent, state: ConsumerState): void {
    switch (event.type) {
      case 'thinking':
        this.handleThinkingEvent(event, state);
        break;
      case 'content':
        this.handleContentEvent(event, state);
        break;
      case 'tool_call_start':
        this.handleToolCallStart(event, state);
        break;
      case 'tool_call_delta':
        this.handleToolCallDelta(event, state);
        break;
      case 'tool_call_done':
        this.handleToolCallDone(event, state);
        break;
      case 'web_search':
        this.handleWebSearch(event, state);
        break;
      case 'usage':
        this.handleUsage(event, state);
        break;
      case 'done':
        this.handleDone(event, state);
        break;
      case 'error':
        // Error events are handled by throwing from the stream
        break;
    }
  }

  /**
   * Handle thinking event.
   */
  private handleThinkingEvent(
    event: ThinkingEvent,
    state: ConsumerState,
  ): void {
    if (!this.options.thinkingEnabled) {
      return;
    }

    state.hadThinking = true;
    state.thinkingBuffer += event.delta;

    // Handle interleaved blocks
    if (
      this.options.handleInterleavedBlocks &&
      event.blockIndex !== undefined
    ) {
      const isNewBlock = event.blockIndex !== state.currentThinkingBlockIndex;

      if (isNewBlock) {
        // Finalize previous thinking stream if exists
        if (state.thinkingStream) {
          state.thinkingStream.finalize();
        }

        // Create new thinking stream
        state.thinkingStream = this.createThinkingStream();
        state.currentThinkingBlockIndex = event.blockIndex;
      }
    } else {
      // Simple mode: single thinking stream
      if (!state.thinkingStream) {
        state.thinkingStream = this.createThinkingStream();
      }
    }

    state.thinkingStream?.append(event.delta);
  }

  /**
   * Handle content event.
   */
  private handleContentEvent(event: ContentEvent, state: ConsumerState): void {
    if (!this.options.outputEnabled) {
      return;
    }

    state.hadContent = true;
    state.contentBuffer += event.delta;

    // Handle interleaved blocks
    if (
      this.options.handleInterleavedBlocks &&
      event.blockIndex !== undefined
    ) {
      const isConsecutive =
        state.outputStream !== null &&
        event.blockIndex === state.currentContentBlockIndex + 1;

      if (!isConsecutive) {
        // Finalize previous output stream if not consecutive
        if (state.outputStream) {
          state.outputStream.finalize();
          state.outputStream = null;
        }

        // Create new output stream
        state.outputStream = this.createOutputStream();
      }

      state.currentContentBlockIndex = event.blockIndex;
    } else {
      // Simple mode: single output stream
      if (!state.outputStream) {
        state.outputStream = this.createOutputStream();
      }
    }

    state.outputStream?.append(event.delta);
  }

  /**
   * Handle tool call start event.
   */
  private handleToolCallStart(
    event: ToolCallStartEvent,
    state: ConsumerState,
  ): void {
    state.toolCalls.set(event.id, {
      id: event.id,
      name: event.name,
      arguments: '',
    });
  }

  /**
   * Handle tool call delta event.
   */
  private handleToolCallDelta(
    event: ToolCallDeltaEvent,
    state: ConsumerState,
  ): void {
    const toolCall = state.toolCalls.get(event.id);
    if (toolCall) {
      toolCall.arguments += event.arguments;
    }
  }

  /**
   * Handle tool call done event.
   */
  private handleToolCallDone(
    _event: ToolCallDoneEvent,
    _state: ConsumerState,
  ): void {
    // Tool call is complete - no action needed as we've accumulated the data
  }

  /**
   * Handle web search event.
   */
  private handleWebSearch(event: WebSearchEvent, state: ConsumerState): void {
    // Deduplicate web search emissions
    if (state.emittedWebSearchIds.has(event.callId)) {
      return;
    }

    state.emittedWebSearchIds.add(event.callId);
    state.webSearchCount++;

    // Emit to progress view
    if (this.options.progressViewEnabled) {
      this.logger.info('', {
        messageType: MESSAGE_TYPES.WEB_SEARCH,
        data: {
          query: event.query,
          results: event.results,
          provider: event.provider,
          callId: event.callId,
          status: event.status,
        },
      });
    }
  }

  /**
   * Handle usage event.
   */
  private handleUsage(_event: UsageEvent, _state: ConsumerState): void {
    // Usage is typically emitted in the done event, but could be used
    // for incremental usage reporting if needed
  }

  /**
   * Handle done event.
   */
  private handleDone(event: DoneEvent, state: ConsumerState): void {
    // Store the final response for use in buildResult
    state.finalResponse = event.response;
  }

  /**
   * Finalize all open streams.
   */
  private finalizeStreams(state: ConsumerState): void {
    if (state.thinkingStream) {
      state.thinkingStream.finalize();
      state.thinkingStream = null;
    }

    if (state.outputStream) {
      state.outputStream.finalize();
      state.outputStream = null;
    }
  }

  /**
   * Build the final consumption result.
   */
  private buildResult(state: ConsumerState): StreamConsumptionResult {
    // If we received a done event with a final response, use it
    if (state.finalResponse) {
      return {
        response: state.finalResponse,
        hadThinking: state.hadThinking,
        hadContent: state.hadContent,
        toolCallCount: state.finalResponse.toolCalls?.length ?? 0,
        webSearchCount: state.webSearchCount,
      };
    }

    // Fallback: build response from accumulated state (should rarely happen)
    const toolCalls = Array.from(state.toolCalls.values());

    const response: NormalizedResponse = {
      text: state.contentBuffer,
      thinking: state.thinkingBuffer || undefined,
      toolCalls:
        toolCalls.length > 0
          ? toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            }))
          : undefined,
      // Default to 'unknown' if no done event was received
      stopReason: 'unknown',
    };

    return {
      response,
      hadThinking: state.hadThinking,
      hadContent: state.hadContent,
      toolCallCount: toolCalls.length,
      webSearchCount: state.webSearchCount,
    };
  }

  /**
   * Create a thinking stream.
   */
  private createThinkingStream(): AgentLogStream {
    return this.logger.createStream(MESSAGE_TYPES.THINKING, {
      progressViewEnabled: this.options.progressViewEnabled,
    });
  }

  /**
   * Create an output stream.
   */
  private createOutputStream(): AgentLogStream {
    return this.logger.createStream(MESSAGE_TYPES.MODEL_RESPONSE, {
      progressViewEnabled: this.options.progressViewEnabled,
    });
  }
}
