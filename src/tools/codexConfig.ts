// Local imports - agent config
import { AgentConfigSchema, type AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  buildAgentWorkspaceOptions,
  type AgentWorkspaceOptions,
} from './agentWorkspaceOptions';
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

const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export const CODEX_REASONING_EFFORTS = REASONING_EFFORTS;
export type CodexReasoningEffort = (typeof REASONING_EFFORTS)[number];

const REASONING_EFFORT_KEY = 'texra.codexReasoningEffort';
const REASONING_EFFORT_DEFAULT: CodexReasoningEffort = 'high';

export const parseCodexReasoningEffort = createEnumParser(
  REASONING_EFFORTS,
  REASONING_EFFORT_DEFAULT,
);

export const getCodexReasoningEffort = createEnumStateGetter(
  REASONING_EFFORT_KEY,
  REASONING_EFFORT_DEFAULT,
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

const APPROVAL_POLICIES = [
  'never',
  'on-request',
  'on-failure',
  'untrusted',
] as const;
export const CODEX_APPROVAL_POLICIES =
  APPROVAL_POLICIES satisfies readonly ApprovalMode[];
export type CodexApprovalPolicy = ApprovalMode;

const APPROVAL_POLICY_KEY = 'texra.codexApprovalPolicy';
const APPROVAL_POLICY_DEFAULT: CodexApprovalPolicy = 'never';

export const parseCodexApprovalPolicy: (raw: string) => CodexApprovalPolicy =
  createEnumParser(APPROVAL_POLICIES, APPROVAL_POLICY_DEFAULT);

export const getCodexApprovalPolicy: () => CodexApprovalPolicy =
  createEnumStateGetter(
    APPROVAL_POLICY_KEY,
    APPROVAL_POLICY_DEFAULT,
    parseCodexApprovalPolicy,
  );

// ============================================================================
// Sandbox mode
// ============================================================================

const SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;
export const CODEX_SANDBOX_MODES =
  SANDBOX_MODES satisfies readonly SandboxMode[];
export type CodexSandboxMode = SandboxMode;

const SANDBOX_MODE_KEY = 'texra.codexSandboxMode';
const SANDBOX_MODE_DEFAULT: CodexSandboxMode = 'workspace-write';

export const parseCodexSandboxMode: (raw: string) => CodexSandboxMode =
  createEnumParser(SANDBOX_MODES, SANDBOX_MODE_DEFAULT);

export const getCodexSandboxMode: () => CodexSandboxMode =
  createEnumStateGetter(
    SANDBOX_MODE_KEY,
    SANDBOX_MODE_DEFAULT,
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

export type CodexWorkspaceOptions = AgentWorkspaceOptions;

/**
 * Compute Codex workspace access options.
 *
 * When no directory is provided, Codex runs from the workspace root.
 * When a subdirectory inside the workspace is provided, we still add the
 * workspace root so the agent can inspect sibling files across the project.
 * Absolute paths outside the workspace (for example a separate git worktree)
 * run in that directory without inheriting the current workspace as an
 * additional root.
 */
export function buildCodexWorkspaceOptions(
  workingDirectoryInput?: string | null,
): CodexWorkspaceOptions {
  return buildAgentWorkspaceOptions(workingDirectoryInput);
}
