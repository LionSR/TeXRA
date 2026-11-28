import { Schema } from 'effect';
import {
  isClaudeCodeModel,
  isCodexModel,
  MODEL_CONFIGS,
  type ModelConfig,
  type ModelRef,
  ReasoningEffort,
} from '@texra-ai/llm';

/**
 * The models and effort levels the two agent CLIs take, by llm-zoo
 * reference. A leaf over llm-zoo: tool modules import it while defining
 * their own schemas.
 */

/** The eligible models that are not deprecated, by reference, in registry
 *  order: what a tool's `model` input lists. */
const currentModels = (
  eligible: (config: ModelConfig) => boolean,
): readonly ModelRef[] =>
  Object.freeze(
    Object.values(MODEL_CONFIGS)
      .filter((config) => eligible(config) && config.deprecated !== true)
      .map((config) => config.ref),
  );

/** The current models the `claude_code` tool's `model` input lists. */
export const CLAUDE_AGENT_MODELS = currentModels(isClaudeCodeModel);
/** The current models the `codex` tool's `model` input lists. */
export const CODEX_MODELS = currentModels(isCodexModel);

/** The model a Claude Code call runs when it names none. */
export const CLAUDE_AGENT_DEFAULT_MODEL: ModelRef =
  'anthropic/claude-sonnet-5-5';

/**
 * The model a Codex call runs when it names none: the newest Codex model. llm-zoo records no release
 * date, so "newest" is not derivable from the registry;
 * `PinnedModels.vitest.ts` checks it is live.
 */
export const CODEX_DEFAULT_MODEL: ModelRef = 'openai/gpt-6.1-sol';

/**
 * An effort level either agent CLI takes. A level the model lacks is snapped
 * to the nearest one it has. `claudeAgentShared.ts` guards this against the
 * Claude SDK's `EffortLevel` and `codexConfig.ts` against the Codex SDK's
 * `ModelReasoningEffort`.
 */
export const AgentCliEffortSchema = Schema.Literals([
  ReasoningEffort.LOW,
  ReasoningEffort.MEDIUM,
  ReasoningEffort.HIGH,
  ReasoningEffort.XHIGH,
  ReasoningEffort.MAX,
]);
export type AgentCliEffort = typeof AgentCliEffortSchema.Type;
