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
} from '@agent/types/ServerToolTypes';
import {
  isFunctionCallArgumentsDoneEvent,
  isOutputItemDoneEvent,
  isReasoningDeltaEvent,
  isReasoningItemAddedEvent,
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
interface ResponseStreamProcessorDeps {
  /** Open a thinking stream for the current reasoning phase (one per phase). */
  createThinkingStream(): StreamHandle;
  /** Open the output stream for the response text. */
  createOutputStream(): StreamHandle;
  /** Extract the final assistant text from a completed response. */
  extractText(response: Response): string;
  /** Emit a web-search result to the progress view. */
  emitWebSearchResult(result: WebSearchResult): void;
  logger: AgentTrace;
}

export class ResponseStreamProcessor {
  /**
   * Open only while the model is inside a reasoning phase. Opening on the
   * reasoning output item — not the first summary delta — lets subscribers
   * surface "the model is thinking" even when no summary text ever streams
   * (e.g. gpt-5 with reasoning summaries disabled).
   */
  private thinkingStream: StreamHandle | null = null;
  private readonly outputStream: StreamHandle;
  private readonly emittedWebSearchIds = new Set<string>();

  constructor(private readonly deps: ResponseStreamProcessorDeps) {
    // Deferred start: announces the response phase at the first text delta.
    // Whether content streams or only the phase boundaries is the handler's
    // output-stream policy, not this processor's concern.
    this.outputStream = deps.createOutputStream();
  }

  /**
   * Process a single streaming event, updating the streaming state.
   * Shared by both WebSocket and HTTP streaming paths for consistent behavior.
   */
  process(event: ResponseStreamEvent): void {
    if (isReasoningDeltaEvent(event)) {
      this.openThinkingStream().append(event.delta);
    } else if (isReasoningItemAddedEvent(event)) {
      this.openThinkingStream();
    } else if (isTextDeltaEvent(event)) {
      this.outputStream.append(event.delta);
    } else if (isWebSearchInProgressEvent(event)) {
      this.closeThinkingStream();
    } else if (isFunctionCallArgumentsDoneEvent(event)) {
      // Function call arguments complete - finalize the thinking stream since
      // no more thinking deltas will arrive after tool calls begin.
      this.closeThinkingStream();
      this.deps.logger.debug(`Tool call ready during streaming: ${event.name}`);
    } else if (isOutputItemDoneEvent(event)) {
      const item = event.item;
      if (item.type === 'reasoning') {
        this.closeThinkingStream();
      } else if (
        isWebSearchItem(item) &&
        !this.emittedWebSearchIds.has(item.id) &&
        hasOpenAIWebSearchData(item)
      ) {
        this.closeThinkingStream();
        this.emitWebSearchOnce(item);
      }
    }
  }

  /**
   * Finalize thinking/output streams and emit remaining web searches.
   * Called after background polling (if needed) completes so the final text
   * reflects the completed response, not the pre-poll snapshot.
   */
  finalize(response: Response): void {
    this.closeThinkingStream();
    this.outputStream.finalize(this.deps.extractText(response));
    this.emitWebSearchesFromResponse(response);
  }

  /**
   * Finalize the thinking/output streams without a completed response. Used on
   * the error path so a mid-stream failure does not leave the progress view's
   * streams hanging in a loading state. Finalizes with no explicit text so any
   * chunks already streamed are preserved (passing `''` would overwrite the
   * visible partial output). `StreamHandle.finalize` is idempotent, so calling
   * this after a partial `finalize` is safe.
   */
  abort(): void {
    this.closeThinkingStream();
    this.outputStream.finalize();
  }

  private openThinkingStream(): StreamHandle {
    return (this.thinkingStream ??= this.deps.createThinkingStream());
  }

  /**
   * Finalize and clear the active thinking stream at a phase boundary.
   * Keeps interleaved thinking/web-search/text segments visually separated;
   * the next reasoning signal opens a fresh stream.
   */
  private closeThinkingStream(): void {
    this.thinkingStream?.finalize();
    this.thinkingStream = null;
  }

  /** Emit a web-search result once, deduped by item id. No-op if already emitted or missing data. */
  private emitWebSearchOnce(item: ResponseFunctionWebSearch): void {
    if (
      this.emittedWebSearchIds.has(item.id) ||
      !hasOpenAIWebSearchData(item)
    ) {
      return;
    }
    this.deps.emitWebSearchResult(buildOpenAIWebSearchResult(item));
    this.emittedWebSearchIds.add(item.id);
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
      if (isWebSearchItem(item)) {
        this.emitWebSearchOnce(item);
      }
    }
  }
}
