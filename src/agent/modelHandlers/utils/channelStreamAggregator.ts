import { ToolCallAccumulator } from './toolCallAccumulator';

/**
 * Shared accumulation core for the two chat-completion-shaped streaming
 * aggregators (`ReasoningStreamAggregator` for OpenAI-compatible
 * reasoning models, `OpenRouterStreamAggregator` for OpenRouter). Both
 * accumulate content text, reasoning text, and streamed tool-call fragments
 * across chunks, then materialize a final response — they differ only in the
 * shape of the chunk they consume and the shape of the response they emit
 * (`ChatCompletion` vs OpenRouter's `ChatResult`), so this base owns the
 * accumulation state and leaves chunk consumption and response construction
 * to each subclass.
 */
export abstract class ChannelStreamAggregator {
  protected readonly contentParts: string[] = [];
  protected readonly reasoningParts: string[] = [];
  protected readonly toolCalls = new ToolCallAccumulator();

  /** Appends a content delta, ignoring empty strings. */
  protected pushContent(delta: string | undefined | null): void {
    if (delta) {
      this.contentParts.push(delta);
    }
  }

  /** Appends a reasoning delta, ignoring empty strings. */
  protected pushReasoning(delta: string | undefined | null): void {
    if (delta) {
      this.reasoningParts.push(delta);
    }
  }

  /** Full accumulated content text, joined in arrival order. */
  getFullContent(): string {
    return this.contentParts.join('');
  }

  /** Full accumulated reasoning text, joined in arrival order. */
  getFullReasoning(): string {
    return this.reasoningParts.join('');
  }
}
