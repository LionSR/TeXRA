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
const OPUS_5_FULLNAME = 'claude-opus-5';
const SONNET_46_FULLNAME = 'claude-sonnet-4-6';
const SONNET_5_FULLNAME = 'claude-sonnet-5';
const FABLE_5_FULLNAME = 'claude-fable-5';
const MYTHOS_5_FULLNAME = 'claude-mythos-5';

// Native context-window sizes come from llm-zoo. Opus 4.6/4.7/4.8/5,
// Sonnet 4.6/5, and the Mythos-class models have a 1M context window at
// standard pricing (no beta header needed); other Claude models use 200K.

/**
 * Model patterns that require temperature removal when thinking is enabled.
 * Per Anthropic docs, Claude 4 and Opus 5 don't support temperature with
 * thinking. Mythos-class models (Fable 5, Mythos 5) and Sonnet 5 reject all
 * sampling parameters (temperature/top_p/top_k), so they belong here too.
 */
const THINKING_TEMPERATURE_EXCLUDED_PATTERNS = [
  'claude-opus-4',
  'claude-opus-5',
  'claude-sonnet-4',
  'claude-sonnet-5',
  'claude-haiku-4',
  'claude-fable-',
  'claude-mythos-',
];

/** Per-family request traits, selected by `fullName` prefix. */
interface AnthropicModelTraits {
  /** Adaptive thinking via the effort parameter, rather than budget_tokens. */
  adaptiveThinking: boolean;
  /** Anthropic's native server-side context compaction. */
  compactionEligible: boolean;
  /**
   * Highest effort tier the family accepts. `'xhigh'` families take the
   * distinct "extra" tier the SDK added in 0.100.0; `'max'` families predate
   * that split and fold a requested `xhigh` into `max`; `'high'` families cap
   * there.
   */
  maxEffort: NonNullable<BetaOutputConfig['effort']> &
    ('high' | 'max' | 'xhigh');
  /**
   * Whether `display: 'summarized'` must be requested. These families default
   * to `'omitted'`, which would suppress reasoning output entirely.
   */
  summarizedDisplay: boolean;
}

/**
 * One row per model family, replacing the five hand-maintained boolean chains
 * these traits used to be spread across. Adding a model is a single new row
 * instead of an edit to every predicate that happens to list its siblings —
 * the drift mode that made the old chains easy to get subtly wrong.
 *
 * Mythos-class models (Fable 5, Mythos 5) share one request surface: adaptive
 * thinking is always on, manual budget_tokens and `thinking: {type:
 * "disabled"}` both return 400, raw chain-of-thought is never returned, and
 * sampling parameters are rejected. They accept the same effort tiers as
 * Opus 4.8 / Opus 5.
 */
const ANTHROPIC_MODEL_TRAITS: ReadonlyArray<
  readonly [prefix: string, traits: AnthropicModelTraits]
> = [
  [
    OPUS_46_FULLNAME,
    {
      adaptiveThinking: true,
      compactionEligible: true,
      maxEffort: 'max',
      summarizedDisplay: false,
    },
  ],
  [
    OPUS_47_FULLNAME,
    {
      adaptiveThinking: true,
      compactionEligible: true,
      maxEffort: 'max',
      summarizedDisplay: true,
    },
  ],
  [
    OPUS_48_FULLNAME,
    {
      adaptiveThinking: true,
      compactionEligible: true,
      maxEffort: 'xhigh',
      summarizedDisplay: true,
    },
  ],
  [
    OPUS_5_FULLNAME,
    {
      adaptiveThinking: true,
      compactionEligible: true,
      maxEffort: 'xhigh',
      summarizedDisplay: true,
    },
  ],
  [
    SONNET_46_FULLNAME,
    {
      adaptiveThinking: true,
      compactionEligible: true,
      maxEffort: 'high',
      summarizedDisplay: false,
    },
  ],
  [
    SONNET_5_FULLNAME,
    {
      adaptiveThinking: true,
      compactionEligible: true,
      maxEffort: 'xhigh',
      summarizedDisplay: true,
    },
  ],
  [
    FABLE_5_FULLNAME,
    {
      adaptiveThinking: true,
      compactionEligible: true,
      maxEffort: 'xhigh',
      summarizedDisplay: true,
    },
  ],
  [
    MYTHOS_5_FULLNAME,
    {
      adaptiveThinking: true,
      compactionEligible: true,
      maxEffort: 'xhigh',
      summarizedDisplay: true,
    },
  ],
];

/** Traits for models with no matching row: manual thinking, capped at 'high'. */
const DEFAULT_MODEL_TRAITS: AnthropicModelTraits = {
  adaptiveThinking: false,
  compactionEligible: false,
  maxEffort: 'high',
  summarizedDisplay: false,
};

function traitsFor(fullName: string): AnthropicModelTraits {
  return (
    ANTHROPIC_MODEL_TRAITS.find(([prefix]) =>
      fullName.startsWith(prefix),
    )?.[1] ?? DEFAULT_MODEL_TRAITS
  );
}

/**
 * Whether this model supports adaptive thinking with the effort parameter.
 * Opus 4.7+, Sonnet 5, and Mythos-class models only accept adaptive thinking —
 * manual budget_tokens returns 400.
 */
export const supportsAdaptiveThinking = (fullName: string): boolean =>
  traitsFor(fullName).adaptiveThinking;

/** Whether this model supports Anthropic's native server-side context compaction. */
export const isCompactionEligibleModel = (fullName: string): boolean =>
  traitsFor(fullName).compactionEligible;

/**
 * Whether temperature must be removed when thinking is enabled.
 * Claude 4 and Opus 5 don't support temperature alongside thinking.
 */
export const requiresNoTemperatureWithThinking = (fullName: string): boolean =>
  THINKING_TEMPERATURE_EXCLUDED_PATTERNS.some((pattern) =>
    fullName.includes(pattern),
  );

/**
 * Returns the Anthropic effort level for the current model.
 * Maps the llm-zoo ReasoningEffort enum to Anthropic's effort levels.
 * Falls back to 'high' (the API default) when no specific effort is configured.
 * The above-'high' tiers are valid for Opus-tier, Sonnet 5, and Mythos-class
 * models: Opus 4.8/5, Sonnet 5, and the Mythos-class models (Fable 5, Mythos 5)
 * accept both the distinct 'xhigh' ("extra") tier and the top 'max' tier, while
 * Opus 4.6/4.7 predate that split and only accept 'max'.
 */
export function mapAnthropicEffort(
  fullName: string,
  reasoningEffort: ReasoningEffort | null,
): BetaOutputConfig['effort'] {
  if (!reasoningEffort) {
    return 'high';
  }

  const { maxEffort } = traitsFor(fullName);
  switch (reasoningEffort) {
    case 'max':
      // The top tier ("Max"). Every family that accepts anything above 'high'
      // accepts 'max'; the rest cap at 'high'.
      return maxEffort === 'high' ? 'high' : 'max';
    case 'xhigh':
      // TeXRA's "Extra High" maps straight to the family's ceiling: 'xhigh'
      // where the SDK 0.100.0 tier split exists, 'max' on the families that
      // predate it, 'high' everywhere else.
      return maxEffort;
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
interface ThinkingConfigInput {
  fullName: string;
  reasoningEffort: ReasoningEffort | null;
  maxTokens: number;
  useStreaming: boolean;
}

/** Resolved thinking configuration to apply onto the create-request params. */
interface ThinkingConfigResult {
  thinking: NonNullable<MessageCreateParams['thinking']>;
  /** Present only for adaptive-thinking models; merge onto output_config. */
  outputConfig?: Pick<BetaOutputConfig, 'effort'>;
  /** Whether temperature must be removed for this model. */
  removeTemperature: boolean;
}

/**
 * Builds the thinking configuration for a create request.
 *
 * Adaptive-thinking models (Opus 4.6/4.7/4.8/5, Sonnet 4.6, Sonnet 5, and
 * Mythos-class models Fable 5 / Mythos 5) use the effort parameter and let the
 * model decide its budget; interleaved thinking is enabled automatically. Older
 * models use a manual budget_tokens cap.
 */
export function buildThinkingConfig({
  fullName,
  reasoningEffort,
  maxTokens,
  useStreaming,
}: ThinkingConfigInput): ThinkingConfigResult {
  const removeTemperature = requiresNoTemperatureWithThinking(fullName);

  if (supportsAdaptiveThinking(fullName)) {
    // Opus 4.6/4.7/4.8/5, Sonnet 4.6, Sonnet 5, and the Mythos-class models
    // (Fable 5, Mythos 5): use adaptive thinking with the effort parameter.
    // Adaptive thinking lets the model decide when and how much to think, and
    // automatically enables interleaved thinking between tool calls.
    // budget_tokens is deprecated (and rejected on Opus 4.7+ / Sonnet 5 /
    // Mythos-class).
    const effort = mapAnthropicEffort(fullName, reasoningEffort);
    // Opus 4.7+, Sonnet 5, and Mythos-class models default display to 'omitted',
    // which suppresses reasoning output (Mythos-class never returns raw CoT at
    // all). Request 'summarized' so thinking still streams to the user — older
    // adaptive-thinking models (Opus 4.6, Sonnet 4.6) already emit reasoning by
    // default and are unaffected.
    const thinking: ThinkingConfigResult['thinking'] = traitsFor(fullName)
      .summarizedDisplay
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
