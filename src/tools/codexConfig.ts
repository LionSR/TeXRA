// Local imports - agent config
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  CodexApprovalPolicySchema,
  CodexReasoningEffortSchema,
  CodexSandboxModeSchema,
} from '@shared/schemas/agentCliSettings';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { createEnumParser, createEnumStateGetter } from './support/enumConfig';
import { CODEX_AGENT_NAME, CODEX_DISPLAY_MODEL } from './codexShared';

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

// Derived from `CodexReasoningEffortSchema` (the single source of truth in
// `@shared`) so the runtime list and the IPC schema can't drift.
const REASONING_EFFORTS = CodexReasoningEffortSchema.options;
export const CODEX_REASONING_EFFORTS = REASONING_EFFORTS;
export type CodexReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const CODEX_REASONING_EFFORT_DEFAULT: CodexReasoningEffort = 'high';

export const parseCodexReasoningEffort = createEnumParser(
  REASONING_EFFORTS,
  CODEX_REASONING_EFFORT_DEFAULT,
);

export const getCodexReasoningEffort = createEnumStateGetter(
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

// Derived from `CodexApprovalPolicySchema` (the single source of truth in
// `@shared`); `satisfies` keeps the schema values aligned with the SDK union.
const APPROVAL_POLICIES = CodexApprovalPolicySchema.options;
export const CODEX_APPROVAL_POLICIES =
  APPROVAL_POLICIES satisfies readonly ApprovalMode[];
export type CodexApprovalPolicy = ApprovalMode;

export const CODEX_APPROVAL_POLICY_DEFAULT: CodexApprovalPolicy = 'never';

export const parseCodexApprovalPolicy: (raw: string) => CodexApprovalPolicy =
  createEnumParser(APPROVAL_POLICIES, CODEX_APPROVAL_POLICY_DEFAULT);

export const getCodexApprovalPolicy: () => CodexApprovalPolicy =
  createEnumStateGetter(
    WorkspaceStateKey.CODEX_APPROVAL_POLICY,
    CODEX_APPROVAL_POLICY_DEFAULT,
    parseCodexApprovalPolicy,
  );

// ============================================================================
// Sandbox mode
// ============================================================================

// Derived from `CodexSandboxModeSchema` (the single source of truth in
// `@shared`); `satisfies` keeps the schema values aligned with the SDK union.
const SANDBOX_MODES = CodexSandboxModeSchema.options;
export const CODEX_SANDBOX_MODES =
  SANDBOX_MODES satisfies readonly SandboxMode[];
export type CodexSandboxMode = SandboxMode;

export const CODEX_SANDBOX_MODE_DEFAULT: CodexSandboxMode = 'workspace-write';

export const parseCodexSandboxMode: (raw: string) => CodexSandboxMode =
  createEnumParser(SANDBOX_MODES, CODEX_SANDBOX_MODE_DEFAULT);

export const getCodexSandboxMode: () => CodexSandboxMode =
  createEnumStateGetter(
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
    model: CODEX_DISPLAY_MODEL,
    instruction: prompt,
    agentCategory: AgentCategory.ToolUse,
  });
}
