// Model-trait and thinking-configuration logic for Anthropic Claude models.
//
// These are pure functions of the model's fullName (and, for effort, the
// configured reasoning effort). Keeping them out of the handler class makes the
// model-specific rules independently testable and lets the handler read as
// orchestration rather than a tangle of version checks.

// Third-party imports
import { ReasoningEffort } from 'llm-zoo';

// Type imports - Anthropic SDK
import type {
  BetaOutputConfig,
  MessageCreateParams,
} from '@anthropic-ai/sdk/resources/beta/messages';

const OPUS_46_FULLNAME = 'claude-opus-4-6';
const OPUS_47_FULLNAME = 'claude-opus-4-7';
const OPUS_48_FULLNAME = 'claude-opus-4-8';
const SONNET_46_FULLNAME = 'claude-sonnet-4-6';

// 1M context window is available natively for Opus 4.6, Opus 4.7, Opus 4.8, and
// Sonnet 4.6 at standard pricing (no beta header needed). Context window sizes
// come from llm-zoo. Other Claude models use 200K.

/**
 * Model patterns that require temperature removal when thinking is enabled.
 * Per Anthropic docs, Claude 4 models don't support temperature with thinking.
 */
const THINKING_TEMPERATURE_EXCLUDED_PATTERNS = [
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
];

export const isClaudeOpus46 = (fullName: string): boolean =>
  fullName.startsWith(OPUS_46_FULLNAME);

export const isClaudeOpus47 = (fullName: string): boolean =>
  fullName.startsWith(OPUS_47_FULLNAME);

export const isClaudeOpus48 = (fullName: string): boolean =>
  fullName.startsWith(OPUS_48_FULLNAME);

export const isClaudeSonnet46 = (fullName: string): boolean =>
  fullName.startsWith(SONNET_46_FULLNAME);

/**
 * Whether this model supports adaptive thinking with the effort parameter.
 * Per Anthropic docs, Opus 4.6, Opus 4.7, Opus 4.8, and Sonnet 4.6 support
 * adaptive thinking. Opus 4.7+ only accepts adaptive thinking — manual
 * budget_tokens returns 400.
 */
export const supportsAdaptiveThinking = (fullName: string): boolean =>
  isClaudeOpus46(fullName) ||
  isClaudeOpus47(fullName) ||
  isClaudeOpus48(fullName) ||
  isClaudeSonnet46(fullName);

/** Whether this model supports Anthropic's native server-side context compaction. */
export const isCompactionEligibleModel = (fullName: string): boolean =>
  isClaudeOpus46(fullName) ||
  isClaudeOpus47(fullName) ||
  isClaudeOpus48(fullName) ||
  isClaudeSonnet46(fullName);

/**
 * Whether temperature must be removed when thinking is enabled.
 * Claude 4 models don't support temperature alongside thinking.
 */
export const requiresNoTemperatureWithThinking = (fullName: string): boolean =>
  THINKING_TEMPERATURE_EXCLUDED_PATTERNS.some((pattern) =>
    fullName.includes(pattern),
  );

/**
 * Returns the Anthropic effort level for the current model.
 * Maps the llm-zoo ReasoningEffort enum to Anthropic's effort levels.
 * Falls back to 'high' (the API default) when no specific effort is configured.
 * The above-'high' tiers are only valid for Opus-tier models: Opus 4.8 accepts
 * both the distinct 'xhigh' ("extra") tier and the top 'max' tier, while Opus
 * 4.6/4.7 predate that split and only accept 'max'.
 */
export function mapAnthropicEffort(
  fullName: string,
  reasoningEffort: ReasoningEffort | null,
): BetaOutputConfig['effort'] {
  if (!reasoningEffort) {
    return 'high';
  }

  switch (reasoningEffort) {
    case 'max':
      // The top tier ("Max"). Opus 4.8/4.7/4.6 all accept Anthropic's 'max'
      // effort; everything else caps at 'high'.
      return isClaudeOpus48(fullName) ||
        isClaudeOpus47(fullName) ||
        isClaudeOpus46(fullName)
        ? 'max'
        : 'high';
    case 'xhigh':
      // Opus 4.8 exposes the distinct 'xhigh' ("extra") effort tier the SDK
      // added in 0.100.0, which is exactly what TeXRA's "Extra High" selector
      // means — map to it directly. Opus 4.6/4.7 predate the tier split and
      // only accept 'max'; everything else caps at 'high'.
      if (isClaudeOpus48(fullName)) return 'xhigh';
      return isClaudeOpus46(fullName) || isClaudeOpus47(fullName)
        ? 'max'
        : 'high';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
    case 'none':
      // Anthropic doesn't support fully disabling thinking; 'low' is the minimum.
      return 'low';
    default:
      return 'high';
  }
}

/** Inputs needed to build the thinking/effort portion of a create request. */
export interface ThinkingConfigInput {
  fullName: string;
  reasoningEffort: ReasoningEffort | null;
  maxTokens: number;
  useStreaming: boolean;
}

/** Resolved thinking configuration to apply onto the create-request params. */
export interface ThinkingConfigResult {
  thinking: NonNullable<MessageCreateParams['thinking']>;
  /** Present only for adaptive-thinking models; merge onto output_config. */
  outputConfig?: Pick<BetaOutputConfig, 'effort'>;
  /** Whether temperature must be removed for this model. */
  removeTemperature: boolean;
}

/**
 * Builds the thinking configuration for a create request.
 *
 * Adaptive-thinking models (Opus 4.6/4.7/4.8, Sonnet 4.6) use the effort
 * parameter and let the model decide its budget; interleaved thinking is enabled
 * automatically. Older models use a manual budget_tokens cap.
 */
export function buildThinkingConfig({
  fullName,
  reasoningEffort,
  maxTokens,
  useStreaming,
}: ThinkingConfigInput): ThinkingConfigResult {
  const removeTemperature = requiresNoTemperatureWithThinking(fullName);

  if (supportsAdaptiveThinking(fullName)) {
    // Opus 4.6, Opus 4.7, Opus 4.8, and Sonnet 4.6: use adaptive thinking
    // with the effort parameter. Adaptive thinking lets the model decide
    // when and how much to think, and automatically enables interleaved
    // thinking between tool calls. budget_tokens is deprecated on these
    // models.
    const effort = mapAnthropicEffort(fullName, reasoningEffort);
    // Opus 4.7+ defaults display to 'omitted', which suppresses reasoning
    // output. Request 'summarized' so thinking tokens still stream to the
    // user — older adaptive-thinking models already emit reasoning by
    // default and are unaffected.
    const thinking: ThinkingConfigResult['thinking'] =
      isClaudeOpus47(fullName) || isClaudeOpus48(fullName)
        ? { type: 'adaptive', display: 'summarized' }
        : { type: 'adaptive' };

    return { thinking, outputConfig: { effort }, removeTemperature };
  }

  // Older models: use manual thinking with budget_tokens
  // budget_tokens must be < max_tokens; use 50% to leave room for actual output
  const maxBudget = Math.floor(maxTokens * 0.5);

  const defaultBudget = useStreaming ? 32768 : 4096;
  const thinkingBudget = Math.min(defaultBudget, maxBudget);

  return {
    thinking: { type: 'enabled', budget_tokens: thinkingBudget },
    removeTemperature,
  };
}
