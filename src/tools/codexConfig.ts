// Local imports - agent config
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@shared/schemas';
import {
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
  parseCodexApprovalPolicy,
  parseCodexReasoningEffort,
  parseCodexSandboxMode,
  type CodexReasoningEffort,
} from '@shared/schemas/agentCliSettings';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { createEnumStateGetter } from './support/enumConfig';
import { CODEX_AGENT_NAME } from './codexShared';

// Type-only imports
import type {
  ApprovalMode,
  ModelReasoningEffort,
  SandboxMode,
} from '@openai/codex-sdk';

// ============================================================================
// Model config — the Codex CLI uses short model names, not versioned API IDs
// ============================================================================

/** Short model name passed to the Codex CLI via --model. */
export const CODEX_CLI_MODEL = 'gpt-5.5';

// ============================================================================
// Reasoning effort
// ============================================================================

const getCodexReasoningEffort = createEnumStateGetter(
  WorkspaceStateKey.CODEX_REASONING_EFFORT,
  CODEX_REASONING_EFFORT_DEFAULT,
  parseCodexReasoningEffort,
);

/**
 * Codex CLI's Rust-side config deserializer only accepts a subset of the
 * reasoning effort tiers TeXRA exposes. TeXRA's 'xhigh' tier is a UI-only
 * extension used by providers like Anthropic Opus 'max'; cap it to 'high'
 * before handing the value to the Codex SDK.
 */
export type CodexCliReasoningEffort = Extract<
  ModelReasoningEffort,
  'low' | 'medium' | 'high'
>;

export function toCodexCliReasoningEffort(
  effort: CodexReasoningEffort,
): CodexCliReasoningEffort {
  return effort === 'xhigh' ? 'high' : effort;
}

export function getCodexCliReasoningEffort(): CodexCliReasoningEffort {
  return toCodexCliReasoningEffort(getCodexReasoningEffort());
}

// ============================================================================
// Approval policy
// ============================================================================

// The schema in `@shared` is the single source of truth for the persisted
// values; the SDK-typed return annotation is what keeps those values aligned
// with the Codex union — a schema value the SDK doesn't accept fails here.
export const getCodexApprovalPolicy: () => ApprovalMode = createEnumStateGetter(
  WorkspaceStateKey.CODEX_APPROVAL_POLICY,
  CODEX_APPROVAL_POLICY_DEFAULT,
  parseCodexApprovalPolicy,
);

// ============================================================================
// Sandbox mode
// ============================================================================

// As above: the SDK-typed return annotation is the alignment guard between the
// persisted schema values and the Codex sandbox union.
export const getCodexSandboxMode: () => SandboxMode = createEnumStateGetter(
  WorkspaceStateKey.CODEX_SANDBOX_MODE,
  CODEX_SANDBOX_MODE_DEFAULT,
  parseCodexSandboxMode,
);

/**
 * Build synthetic execution metadata for Codex child streams.
 *
 * Codex runs outside the normal model-handler pipeline, so we provide an
 * explicit tool-use category and a stable Codex model label for the UI
 * instead of inheriting the generic AgentConfig defaults.
 */
export function buildCodexConfig(prompt: string): AgentConfig {
  return AgentConfigSchema.parse({
    agent: CODEX_AGENT_NAME,
    // Fabricated label, not a routed model: Codex drives its own model.
    model: 'gpt55',
    instruction: prompt,
    agentCategory: AgentCategory.ToolUse,
  });
}
