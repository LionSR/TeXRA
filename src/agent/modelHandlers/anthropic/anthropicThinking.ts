// Local request-shaping and thinking-configuration logic for Anthropic models.
// Adaptive-thinking support and accepted effort values come from the selected
// llm-zoo registry entry; fullName is used only for Anthropic family traits.

// Third-party imports
import { ReasoningEffort, type ModelCapabilities } from 'llm-zoo';

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
const FABLE_FAMILY_PREFIX = 'claude-fable-';
const MYTHOS_FAMILY_PREFIX = 'claude-mythos-';

// Native context-window sizes come from llm-zoo. Opus 4.6/4.7/4.8/5,
// Sonnet 4.6/5, and the Mythos-class models have a 1M context window at
// standard pricing (no beta header needed); other Claude models use 200K.

/**
 * Model patterns that require temperature removal when thinking is enabled.
 * Per Anthropic docs, Claude 4 and Opus 5 don't support temperature with
 * thinking. Mythos-class models (Fable 5, Mythos 5) and Sonnet 5 reject all
 * sampling parameters (temperature/top_p/top_k), so they belong here too.
 *
 * Kept separate from {@link ANTHROPIC_REQUEST_TRAITS}: compaction/display are
 * version-specific, while temperature exclusion applies to the whole Claude 4
 * family (e.g. still-supported `claude-sonnet-4-5`).
 */
const THINKING_TEMPERATURE_EXCLUDED_PATTERNS = [
  'claude-opus-4',
  'claude-opus-5',
  'claude-sonnet-4',
  'claude-sonnet-5',
  'claude-haiku-4',
  'claude-fable-',
  'claude-mythos-',
] as const;

/** Local Anthropic request traits selected by `fullName` prefix. */
interface AnthropicRequestTraits {
  /** Anthropic's native server-side context compaction. */
  compactionEligible: boolean;
  /**
   * Whether `display: 'summarized'` must be requested. These families default
   * to `'omitted'`, which would suppress reasoning output entirely.
   */
  summarizedDisplay: boolean;
}

/**
 * Traits that remain local because they shape Anthropic-specific requests and
 * are not model capabilities owned by llm-zoo.
 */
const ANTHROPIC_REQUEST_TRAITS: ReadonlyArray<
  readonly [prefix: string, traits: AnthropicRequestTraits]
> = [
  [OPUS_46_FULLNAME, { compactionEligible: true, summarizedDisplay: false }],
  [OPUS_47_FULLNAME, { compactionEligible: true, summarizedDisplay: true }],
  [OPUS_48_FULLNAME, { compactionEligible: true, summarizedDisplay: true }],
  [OPUS_5_FULLNAME, { compactionEligible: true, summarizedDisplay: true }],
  [SONNET_46_FULLNAME, { compactionEligible: true, summarizedDisplay: false }],
  [SONNET_5_FULLNAME, { compactionEligible: true, summarizedDisplay: true }],
  // Mythos-class entries match the whole family: their API default is display
  // 'omitted', so a new family member falling through to DEFAULT_REQUEST_TRAITS
  // would silently lose all visible reasoning output.
  [MYTHOS_FAMILY_PREFIX, { compactionEligible: true, summarizedDisplay: true }],
  [FABLE_FAMILY_PREFIX, { compactionEligible: true, summarizedDisplay: true }],
];

const DEFAULT_REQUEST_TRAITS: AnthropicRequestTraits = {
  compactionEligible: false,
  summarizedDisplay: false,
};

function requestTraitsFor(fullName: string): AnthropicRequestTraits {
  return (
    ANTHROPIC_REQUEST_TRAITS.find(([prefix]) =>
      fullName.startsWith(prefix),
    )?.[1] ?? DEFAULT_REQUEST_TRAITS
  );
}

/** Whether this model supports Anthropic's native server-side context compaction. */
export const isCompactionEligibleModel = (fullName: string): boolean =>
  requestTraitsFor(fullName).compactionEligible;

/**
 * Whether temperature must be removed when thinking is enabled.
 * Claude 4 and Opus 5 don't support temperature alongside thinking.
 */
export const requiresNoTemperatureWithThinking = (fullName: string): boolean =>
  THINKING_TEMPERATURE_EXCLUDED_PATTERNS.some((pattern) =>
    fullName.includes(pattern),
  );

type AnthropicEffort = NonNullable<BetaOutputConfig['effort']>;
type AnthropicReasoningEffort = Exclude<ReasoningEffort, ReasoningEffort.NONE>;

const ANTHROPIC_EFFORT_ORDER: readonly AnthropicReasoningEffort[] = [
  ReasoningEffort.LOW,
  ReasoningEffort.MEDIUM,
  ReasoningEffort.HIGH,
  ReasoningEffort.XHIGH,
  ReasoningEffort.MAX,
];

/**
 * Normalizes a requested effort to llm-zoo's exact accepted vocabulary.
 * Entries without a vocabulary retain the legacy low/medium/high behavior and
 * cap above-high requests at high.
 */
export function normalizeAnthropicEffort(
  supportedReasoningEfforts: ModelCapabilities['supportedReasoningEfforts'],
  reasoningEffort: ReasoningEffort | null,
): AnthropicEffort {
  const requested =
    reasoningEffort === ReasoningEffort.NONE
      ? ReasoningEffort.LOW
      : (reasoningEffort ?? ReasoningEffort.HIGH);

  if (!supportedReasoningEfforts?.length) {
    return requested === ReasoningEffort.MAX ||
      requested === ReasoningEffort.XHIGH
      ? 'high'
      : requested;
  }

  if (supportedReasoningEfforts.includes(requested)) {
    return requested;
  }

  // The families that introduced `max` before `xhigh` accept xhigh intent at
  // their `max` tier rather than lowering it to high.
  if (
    requested === ReasoningEffort.XHIGH &&
    supportedReasoningEfforts.includes(ReasoningEffort.MAX)
  ) {
    return 'max';
  }

  const requestedIndex = ANTHROPIC_EFFORT_ORDER.indexOf(requested);
  return (
    ANTHROPIC_EFFORT_ORDER.slice(0, requestedIndex + 1).findLast((effort) =>
      supportedReasoningEfforts.includes(effort),
    ) ??
    ANTHROPIC_EFFORT_ORDER.find((effort) =>
      supportedReasoningEfforts.includes(effort),
    ) ??
    'high'
  );
}

/** Inputs needed to build the thinking/effort portion of a create request. */
interface ThinkingConfigInput {
  fullName: string;
  capabilities: Pick<
    ModelCapabilities,
    'supportsAdaptiveThinking' | 'supportedReasoningEfforts'
  >;
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
 * Builds the thinking configuration for a create request. Adaptive entries use
 * the effort parameter and let the model decide its budget; other thinking
 * entries use a manual budget_tokens cap.
 */
export function buildThinkingConfig({
  fullName,
  capabilities,
  reasoningEffort,
  maxTokens,
  useStreaming,
}: ThinkingConfigInput): ThinkingConfigResult {
  const removeTemperature = requiresNoTemperatureWithThinking(fullName);

  if (capabilities.supportsAdaptiveThinking) {
    const effort = normalizeAnthropicEffort(
      capabilities.supportedReasoningEfforts,
      reasoningEffort,
    );
    const thinking: ThinkingConfigResult['thinking'] = requestTraitsFor(
      fullName,
    ).summarizedDisplay
      ? { type: 'adaptive', display: 'summarized' }
      : { type: 'adaptive' };

    return { thinking, outputConfig: { effort }, removeTemperature };
  }

  // Manual budget_tokens must be < max_tokens. Reserve half for final output.
  const maxBudget = Math.floor(maxTokens * 0.5);
  const defaultBudget = useStreaming ? 32768 : 4096;
  const thinkingBudget = Math.min(defaultBudget, maxBudget);

  return {
    thinking: { type: 'enabled', budget_tokens: thinkingBudget },
    removeTemperature,
  };
}
