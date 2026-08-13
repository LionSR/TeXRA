// Streaming-event aggregator for the OpenAI Responses API.
//
// Encapsulates the per-request streaming state (thinking/output streams,
// emitted web-search IDs, accumulated output items and text) and the event
// state-machine shared by the WebSocket transport and the HTTP streaming loop.
// The handler creates one processor per request, feeds it events via
// `process()`, and calls `finalize()` once the terminal response is known
// (after any background polling).

import type { AgentTrace, StreamHandle } from '@agent/trace';
import {
  buildOpenAIWebSearchResult,
  hasOpenAIWebSearchData,
  type WebSearchResult,
} from '@agent/types/ServerTools';
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
  private readonly outputItems: Response['output'] = [];
  private outputText = '';

  constructor(private readonly deps: ResponseStreamProcessorDeps) {
    // Deferred start: announces the response phase at the first text delta.
    // Whether content streams or only the phase boundaries is the handler's
    // output-stream policy, not this processor's concern.
    this.outputStream = deps.createOutputStream();
  }

  /**
   * Complete output items seen on `response.output_item.done` (message, tool
   * call, or reasoning). Some backends (the Codex subscription endpoint) leave
   * the completed response's `output` empty, so the handler rebuilds it from
   * these — otherwise the whole turn, tool calls included, is dropped.
   */
  get streamedItems(): Response['output'] {
    return this.outputItems;
  }

  /**
   * Text accumulated from the output deltas: rebuilds a sparse completed
   * response's `output_text`, and surfaces the partial tail when a stream
   * fails mid-flight (the Responses stream has no native currentMessage
   * accessor).
   */
  get streamedText(): string {
    return this.outputText;
  }

  /**
   * Process a single streaming event, updating the streaming state.
   * Shared by both WebSocket and HTTP streaming paths for consistent behavior.
   */
  process(event: ResponseStreamEvent): void {
    if (
      event.type === 'response.reasoning_text.delta' ||
      event.type === 'response.reasoning_summary_text.delta'
    ) {
      this.openThinkingStream().append(event.delta);
    } else if (
      // Fires even when no reasoning summary text will ever stream (e.g. gpt-5
      // with summaries disabled), so it is the reliable "started thinking" signal.
      event.type === 'response.output_item.added' &&
      event.item.type === 'reasoning'
    ) {
      this.openThinkingStream();
    } else if (event.type === 'response.output_text.delta') {
      this.outputText += event.delta;
      this.outputStream.append(event.delta);
    } else if (event.type === 'response.web_search_call.in_progress') {
      this.closeThinkingStream();
    } else if (event.type === 'response.function_call_arguments.done') {
      // Function call arguments complete - finalize the thinking stream since
      // no more thinking deltas will arrive after tool calls begin.
      this.closeThinkingStream();
      this.deps.logger.debug(`Tool call ready during streaming: ${event.name}`);
    } else if (event.type === 'response.output_item.done') {
      const item = event.item;
      this.outputItems.push(item);
      if (item.type === 'reasoning') {
        this.closeThinkingStream();
      } else if (
        item.type === 'web_search_call' &&
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
      if (item.type === 'web_search_call') {
        this.emitWebSearchOnce(item);
      }
    }
  }
}
