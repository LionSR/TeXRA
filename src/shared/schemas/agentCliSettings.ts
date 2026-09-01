import { z } from 'zod';

/**
 * Agent CLI setting value schemas shared by settings IPC and tool runtimes.
 *
 * Keep this module dependency-free: tool modules import it while defining their
 * own runtime schemas, so it must not pull in settings-view or tool code.
 */

function parseEnumSetting<T extends string>(
  values: readonly T[],
  fallback: T,
): (raw: unknown) => T {
  return (raw: unknown): T =>
    typeof raw === 'string' && (values as readonly string[]).includes(raw)
      ? (raw as T)
      : fallback;
}

/** Valid Codex sandbox modes. */
export const CodexSandboxModeSchema = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
export type CodexSandboxMode = z.infer<typeof CodexSandboxModeSchema>;

export const CODEX_SANDBOX_MODE_DEFAULT: CodexSandboxMode = 'workspace-write';
export const parseCodexSandboxMode = parseEnumSetting(
  CodexSandboxModeSchema.options,
  CODEX_SANDBOX_MODE_DEFAULT,
);

/** Valid Codex reasoning effort levels. */
export const CodexReasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
]);
export type CodexReasoningEffort = z.infer<typeof CodexReasoningEffortSchema>;

export const CODEX_REASONING_EFFORT_DEFAULT: CodexReasoningEffort = 'high';
export const parseCodexReasoningEffort = parseEnumSetting(
  CodexReasoningEffortSchema.options,
  CODEX_REASONING_EFFORT_DEFAULT,
);

/** Valid Codex approval policies. */
export const CodexApprovalPolicySchema = z.enum([
  'never',
  'on-request',
  'untrusted',
  'on-failure',
]);
export type CodexApprovalPolicy = z.infer<typeof CodexApprovalPolicySchema>;

export const CODEX_APPROVAL_POLICY_DEFAULT: CodexApprovalPolicy = 'never';
export const parseCodexApprovalPolicy = parseEnumSetting(
  CodexApprovalPolicySchema.options,
  CODEX_APPROVAL_POLICY_DEFAULT,
);

/** Claude Code CLI model options surfaced in the picker. */
export const ClaudeAgentModelSchema = z.enum([
  'claude-sonnet-5',
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-haiku-4-5-20251001',
]);
export type ClaudeAgentModel = z.infer<typeof ClaudeAgentModelSchema>;

export const CLAUDE_AGENT_DEFAULT_MODEL: ClaudeAgentModel = 'claude-sonnet-5';

const parseClaudeAgentModelEnum = parseEnumSetting(
  ClaudeAgentModelSchema.options,
  CLAUDE_AGENT_DEFAULT_MODEL,
);

/**
 * Claude Fable 5 was retired in favor of Fable 5.1 (identical specs/pricing,
 * cheaper cache reads). Map a previously-persisted `claude-fable-5` forward
 * instead of letting the enum parser silently discard it back to the
 * default -- `readSetting` runs this before `schema.safeParse`, so an
 * unmapped legacy id would already look "valid" by the time the loud
 * invalid-value warning path could fire.
 */
export function parseClaudeAgentModel(raw: unknown): ClaudeAgentModel {
  if (raw === 'claude-fable-5') return 'claude-fable-5-1';
  return parseClaudeAgentModelEnum(raw);
}

/** Claude Code CLI permission modes exposed in settings. */
export const ClaudeAgentPermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]);
export type ClaudeAgentPermissionMode = z.infer<
  typeof ClaudeAgentPermissionModeSchema
>;

export const CLAUDE_AGENT_DEFAULT_PERMISSION_MODE: ClaudeAgentPermissionMode =
  'acceptEdits';
export const parseClaudeAgentPermissionMode = parseEnumSetting(
  ClaudeAgentPermissionModeSchema.options,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
);

/**
 * Claude Code CLI effort levels. `claudeAgentShared.ts` guards this against the
 * SDK's `EffortLevel` union at compile time.
 */
export const ClaudeAgentEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ClaudeAgentEffort = z.infer<typeof ClaudeAgentEffortSchema>;

export const CLAUDE_AGENT_DEFAULT_EFFORT: ClaudeAgentEffort = 'high';
export const parseClaudeAgentEffort = parseEnumSetting(
  ClaudeAgentEffortSchema.options,
  CLAUDE_AGENT_DEFAULT_EFFORT,
);

export const BASH_APPROVAL_CONFIG_KEY = 'texra.toolUse.requireBashApproval';
