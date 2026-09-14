// Local imports - agent config
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { StateStore } from '@platform/interfaces';
import type { CodexReasoningEffort } from '@shared/schemas';
import {
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
  parseCodexApprovalPolicy,
  parseCodexReasoningEffort,
  parseCodexSandboxMode,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { buildSyntheticToolUseConfig } from '@tools/core/syntheticAgentConfig';
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
 * Older Codex CLI runtimes reject `xhigh` even though it is present in the SDK
 * type. Preserve the requested level only after the resolved binary has been
 * checked; otherwise cap it to `high`.
 */
type CodexCliReasoningEffort = Extract<
  ModelReasoningEffort,
  'low' | 'medium' | 'high' | 'xhigh'
>;

export function toCodexCliReasoningEffort(
  effort: CodexReasoningEffort,
  supportsXhigh = false,
): CodexCliReasoningEffort {
  return effort === 'xhigh' && !supportsXhigh ? 'high' : effort;
}

export function getCodexCliReasoningEffort(
  state: StateStore,
  supportsXhigh = false,
): CodexCliReasoningEffort {
  return toCodexCliReasoningEffort(
    getCodexReasoningEffort(state),
    supportsXhigh,
  );
}

// ============================================================================
// Approval policy
// ============================================================================

// The schema in `@shared` is the single source of truth for the persisted
// values; the SDK-typed return annotation is what keeps those values aligned
// with the Codex union — a schema value the SDK doesn't accept fails here.
export const getCodexApprovalPolicy = (state: StateStore): ApprovalMode =>
  createEnumStateGetter(
    WorkspaceStateKey.CODEX_APPROVAL_POLICY,
    CODEX_APPROVAL_POLICY_DEFAULT,
    parseCodexApprovalPolicy,
  )(state);

// ============================================================================
// Sandbox mode
// ============================================================================

// As above: the SDK-typed return annotation is the alignment guard between the
// persisted schema values and the Codex sandbox union.
export const getCodexSandboxMode = (state: StateStore): SandboxMode =>
  createEnumStateGetter(
    WorkspaceStateKey.CODEX_SANDBOX_MODE,
    CODEX_SANDBOX_MODE_DEFAULT,
    parseCodexSandboxMode,
  )(state);

/**
 * Build synthetic run metadata for Codex child runs.
 *
 * Codex runs outside the normal run loop, so we provide an explicit
 * tool-use category and a stable Codex model label for the UI
 * instead of inheriting the generic AgentConfig defaults.
 */
export function buildCodexConfig(prompt: string): AgentConfig {
  return buildSyntheticToolUseConfig({
    agent: CODEX_AGENT_NAME,
    // Fabricated label, not a routed model: Codex drives its own model.
    model: 'gpt55',
    instruction: prompt,
  });
}
