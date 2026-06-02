// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';

// Type imports
import type { DeepSeekToolCall, OpenAIToolCall } from '../types/IModelHandler';

/**
 * Intermediate base for OpenAI-compatible providers that expose a separate
 * reasoning channel (`reasoning_content` / `reasoning_details`): DeepSeek,
 * Kimi, GLM, MiniMax.
 *
 * It captures only the overrides that are *identical across every* such
 * handler, so reparenting changes no behavior:
 *
 * - `useReasoningStreamAggregator` — reasoning models stream reasoning and
 *   content on separate channels, so the aggregator is always on.
 * - `shouldIncludeReasoningInToolCalls()` — when the model reasons, its
 *   reasoning must be replayed into tool-use follow-up messages.
 *
 * Overrides that vary between these providers stay on the concrete handlers:
 * `requiresBatchedParallelToolResults` (GLM does not batch), the
 * content-stringification flags (DeepSeek stringifies unconditionally while
 * Kimi/GLM/MiniMax preserve vision parts), the `thinking`/`reasoning_split`
 * parameter shape, and each provider's reasoning-field extraction.
 *
 * Providers that merely tolerate reasoning tokens without a separate channel
 * (xAI, DashScope) intentionally keep extending {@link ModelHandlerOpenAI}.
 */
export class ReasoningModelHandlerOpenAI<
  TCall extends OpenAIToolCall | DeepSeekToolCall = OpenAIToolCall,
> extends ModelHandlerOpenAI<TCall> {
  protected override useReasoningStreamAggregator = true;

  protected override shouldIncludeReasoningInToolCalls(): boolean {
    return this.capabilities.supportsReasoning;
  }
}
