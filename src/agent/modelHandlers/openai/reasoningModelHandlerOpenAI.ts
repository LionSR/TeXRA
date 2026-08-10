// Local file imports
import type {
  DeepSeekToolCall,
  OpenAIToolCall,
} from '@agent/types/ModelHandlerContracts';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';

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
 * - `requiresBatchedParallelToolResults` — most providers with separate
 *   reasoning channels need one batched follow-up message to preserve that
 *   reasoning across parallel tool calls. Unconditional here (not gated on
 *   `capabilities.supportsReasoning`) because it's a family-wide wire-format
 *   fact, not a per-model reasoning toggle — see the base getter's doc
 *   comment (#7101 triage).
 *
 * Overrides that vary between these providers stay on the concrete handlers:
 * the GLM batching exception, content-stringification flags (DeepSeek
 * stringifies unconditionally while Kimi/GLM/MiniMax preserve vision parts),
 * the `thinking`/`reasoning_split` parameter shape, and each provider's
 * reasoning-field extraction.
 *
 * Providers that merely tolerate reasoning tokens without a separate channel
 * (xAI, DashScope) intentionally keep extending {@link ModelHandlerOpenAI}.
 */
export class ReasoningModelHandlerOpenAI<
  TCall extends OpenAIToolCall | DeepSeekToolCall = OpenAIToolCall,
> extends ModelHandlerOpenAI<TCall> {
  protected override useReasoningStreamAggregator = true;

  override get requiresBatchedParallelToolResults(): boolean {
    return true;
  }

  protected override shouldIncludeReasoningInToolCalls(): boolean {
    return this.capabilities.supportsReasoning;
  }
}
