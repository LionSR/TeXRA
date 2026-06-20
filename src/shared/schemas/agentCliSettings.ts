import { z } from 'zod';

/**
 * Agent CLI setting value schemas shared by settings IPC and tool runtimes.
 *
 * Keep this module dependency-free: tool modules import it while defining their
 * own runtime schemas, so it must not pull in settings-view or tool code.
 */

/** Valid Codex sandbox modes. */
export const CodexSandboxModeSchema = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
export type CodexSandboxMode = z.infer<typeof CodexSandboxModeSchema>;

/** Valid Codex reasoning effort levels. */
export const CodexReasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
]);
export type CodexReasoningEffort = z.infer<typeof CodexReasoningEffortSchema>;

/** Valid Codex approval policies. */
export const CodexApprovalPolicySchema = z.enum([
  'never',
  'on-request',
  'on-failure',
  'untrusted',
]);
export type CodexApprovalPolicy = z.infer<typeof CodexApprovalPolicySchema>;

/** Claude Code CLI model options surfaced in the picker. */
export const ClaudeAgentModelSchema = z.enum([
  'claude-sonnet-4-6',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-haiku-4-5-20251001',
]);
export type ClaudeAgentModel = z.infer<typeof ClaudeAgentModelSchema>;

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
