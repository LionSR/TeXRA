// Streaming-event aggregator for the OpenAI Responses API.
//
// Encapsulates the per-request streaming state (thinking/output streams,
// emitted web-search IDs) and the event state-machine shared by the WebSocket
// transport and the HTTP streaming loop. The handler creates one processor per
// request, feeds it events via `process()`, and calls `finalize()` once the
// terminal response is known (after any background polling).

import type { AgentTrace, StreamHandle } from '@agent/trace';
import {
  buildOpenAIWebSearchResult,
  hasOpenAIWebSearchData,
  type WebSearchResult,
} from '../types/ServerToolTypes';
import {
  isFunctionCallArgumentsDoneEvent,
  isOutputItemDoneEvent,
  isReasoningDeltaEvent,
  isTextDeltaEvent,
  isWebSearchInProgressEvent,
  isWebSearchItem,
} from './responseStreamEvents';
import type {
  Response,
  ResponseFunctionWebSearch,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

/** Collaborators the processor borrows from the owning handler. */
export interface ResponseStreamProcessorDeps {
  /** Open a fresh thinking stream (used on creation and after each rotation). */
  createThinkingStream(): StreamHandle;
  /** Open the output stream (only called when output streaming is enabled). */
  createOutputStream(): StreamHandle;
  /** Whether the final text should be streamed to an output stream. */
  outputStreamingEnabled: boolean;
  /** Extract the final assistant text from a completed response. */
  extractText(response: Response): string;
  /** Emit a web-search result to the progress view. */
  emitWebSearchResult(result: WebSearchResult): void;
  logger: AgentTrace;
}

export class ResponseStreamProcessor {
  private thinkingStream: StreamHandle;
  private readonly outputStream: StreamHandle | null;
  private readonly emittedWebSearchIds = new Set<string>();
  private hasThinkingContent = false;

  constructor(private readonly deps: ResponseStreamProcessorDeps) {
    this.thinkingStream = deps.createThinkingStream();
    this.outputStream = deps.outputStreamingEnabled
      ? deps.createOutputStream()
      : null;
  }

  /**
   * Process a single streaming event, updating the streaming state.
   * Shared by both WebSocket and HTTP streaming paths for consistent behavior.
   */
  process(event: ResponseStreamEvent): void {
    if (isReasoningDeltaEvent(event)) {
      this.thinkingStream.append(event.delta);
      this.hasThinkingContent = true;
    } else if (isTextDeltaEvent(event)) {
      this.outputStream?.append(event.delta);
    } else if (isWebSearchInProgressEvent(event)) {
      this.rotateThinkingStream();
    } else if (isFunctionCallArgumentsDoneEvent(event)) {
      // Function call arguments complete - finalize streams since no more
      // text/thinking deltas will arrive after tool calls begin.
      this.rotateThinkingStream();
      this.deps.logger.debug(`Tool call ready during streaming: ${event.name}`);
    } else if (isOutputItemDoneEvent(event)) {
      const item = event.item;
      if (
        isWebSearchItem(item) &&
        !this.emittedWebSearchIds.has(item.id) &&
        hasOpenAIWebSearchData(item)
      ) {
        this.rotateThinkingStream();
        this.emitWebSearch(item);
        this.emittedWebSearchIds.add(item.id);
      }
    }
  }

  /**
   * Finalize thinking/output streams and emit remaining web searches.
   * Called after background polling (if needed) completes so the final text
   * reflects the completed response, not the pre-poll snapshot.
   */
  finalize(response: Response): void {
    if (this.hasThinkingContent) {
      this.thinkingStream.finalize();
    }
    const finalText = this.deps.extractText(response);
    if (this.outputStream) this.outputStream.finalize(finalText);
    this.emitWebSearchesFromResponse(response);
  }

  /**
   * Finalize and reset the thinking stream if it has content.
   * Keeps interleaved thinking/web-search/text segments visually separated.
   */
  private rotateThinkingStream(): void {
    if (!this.hasThinkingContent) return;
    this.thinkingStream.finalize();
    this.hasThinkingContent = false;
    this.thinkingStream = this.deps.createThinkingStream();
  }

  /** Emit a single web-search result to the progress view. */
  private emitWebSearch(item: ResponseFunctionWebSearch): void {
    this.deps.emitWebSearchResult(buildOpenAIWebSearchResult(item));
  }

  /**
   * Emit web searches from the final response that weren't already emitted
   * during streaming. Fallback for missed streaming events (network
   * interruptions, SDK edge cases) and the non-streaming path entirely.
   */
  private emitWebSearchesFromResponse(response: Response): void {
    const output = response?.output;
    if (!Array.isArray(output)) {
      return;
    }

    for (const item of output) {
      if (
        isWebSearchItem(item) &&
        !this.emittedWebSearchIds.has(item.id) &&
        hasOpenAIWebSearchData(item)
      ) {
        this.emitWebSearch(item);
        this.emittedWebSearchIds.add(item.id);
      }
    }
  }
}
