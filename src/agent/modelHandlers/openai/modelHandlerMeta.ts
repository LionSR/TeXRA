// Local file imports
import { ModelHandlerOpenAIResponse } from './modelHandlerOpenAIResponse';

// Type imports
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';

/**
 * Handler for Meta Muse Spark models via the Meta Model API
 * (https://api.meta.ai/v1).
 *
 * Meta serves three request formats off one base URL; TeXRA uses the
 * Responses surface because the Chat Completions surface supports neither
 * tool calling nor cross-turn reasoning ("Chat Completions does not carry
 * reasoning across turns") — both are Responses-only. Where TeXRA touches it,
 * the wire contract matches OpenAI's Responses API, so the base handler
 * applies without request rewriting:
 *  - `reasoning: { effort, summary }` (nested lowercase keys; effort accepts
 *    minimal|low|medium|high|xhigh, and `none` is rejected because Muse Spark
 *    always reasons — the shared `toOpenAIReasoningEffort` clamp already
 *    floors `none` to `low` and caps `max` to `xhigh`);
 *  - flat `tools` entries, `function_call` / `function_call_output` items,
 *    `parallel_tool_calls`;
 *  - `store: true` default with `previous_response_id` chaining, or
 *    `store: false` + `include: ["reasoning.encrypted_content"]` replay;
 *  - top-level `instructions` do not persist across turns, and the base
 *    handler already resends them on every request.
 *
 * Background mode stays off: the base eligibility gate is GPT-family-named,
 * and although Meta documents `background: true` + GET polling with the same
 * status vocabulary, enabling it here is unexercised — revisit if long
 * workflow runs start timing out. WebSocket transport self-disables on any
 * non-null base URL. API key and base URL resolve generically from
 * `config.provider` ('meta').
 *
 * @see https://ai.developer.meta.com/docs/features/responses
 * @see https://ai.developer.meta.com/docs/features/reasoning
 * @see https://ai.developer.meta.com/docs/features/tool-calling
 */
export class ModelHandlerMeta extends ModelHandlerOpenAIResponse {
  /** Tag usage with the Meta provider, not the OpenAI Responses surface. */
  protected override get usageProvider(): NormalizedUsage['provider'] {
    return 'meta';
  }

  /**
   * The base getter assumes every directly-routed backend implements OpenAI's
   * `/responses/input_tokens` endpoint; Meta's token-counting support is not
   * verified for that endpoint, so defer to the per-model llm-zoo capability
   * (false for Muse Spark) and let the heuristic fallback size the budget.
   */
  override get supportsTokenCounting(): boolean {
    return this.capabilities.supportsTokenCounting;
  }
}
