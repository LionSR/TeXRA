import {
  MODEL_CONFIGS,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
  type ModelRef,
} from 'llm-zoo';
import { z } from 'zod';

/**
 * Agent CLI setting value schemas shared by settings IPC and tool runtimes.
 *
 * Keep this module a leaf over llm-zoo and the reasoning policy: tool modules
 * import it while defining their own runtime schemas, so it must not pull in
 * settings-view or tool code.
 */

// ============================================================================
// Models and effort — both agent CLIs name their model by llm-zoo reference
// ============================================================================

/** A model the Claude Code CLI can run: any Anthropic model still served. */
export const isClaudeCodeModel = (config: ModelConfig): boolean =>
  config.provider === ModelProvider.ANTHROPIC && config.retired !== true;

/** A model the Codex CLI can run: an OpenAI model the Codex backend serves. */
export const isCodexModel = (config: ModelConfig): boolean =>
  config.provider === ModelProvider.OPENAI &&
  config.codexSubscription === true &&
  config.retired !== true;

/** The picker's models: the eligible ones that are not deprecated, in registry order. */
function pickerModels(eligible: (config: ModelConfig) => boolean) {
  const configs = Object.values(MODEL_CONFIGS).filter(
    (config) => eligible(config) && config.deprecated !== true,
  );
  return {
    schema: z.enum(configs.map((config) => config.ref)),
    labels: configs.map((config) => config.label),
  };
}

const claudeCodeModels = pickerModels(isClaudeCodeModel);
const codexModels = pickerModels(isCodexModel);

/** The Claude Code model setting: a bare reference; effort is its own setting. */
export const ClaudeAgentModelSchema = claudeCodeModels.schema;
const CLAUDE_AGENT_DEFAULT_MODEL: ModelRef = 'anthropic/claude-sonnet-5-5';

/** The Codex model setting: a bare reference; effort is its own setting. */
const CodexModelSchema = codexModels.schema;
/**
 * The newest Codex model. llm-zoo records no release date, so "newest" is
 * not derivable from the registry; a test holds this to the picker.
 */
const CODEX_DEFAULT_MODEL: ModelRef = 'openai/gpt-6.1-sol';

/**
 * The saved effort level for either agent CLI, passed to the reasoning policy
 * as the user's level: the tool call's or model string's own effort wins, and
 * a level the model lacks is snapped to the nearest one it has.
 * `claudeAgentShared.ts` guards this against the Claude SDK's `EffortLevel`
 * and `codexConfig.ts` against the Codex SDK's `ModelReasoningEffort`.
 */
export const AgentCliEffortSchema = z.enum([
  ReasoningEffort.LOW,
  ReasoningEffort.MEDIUM,
  ReasoningEffort.HIGH,
  ReasoningEffort.XHIGH,
  ReasoningEffort.MAX,
]);
export type AgentCliEffort = z.infer<typeof AgentCliEffortSchema>;

/** The reasoning policy's `DEFAULT_EFFORT` (a test holds them equal). */
const AGENT_CLI_EFFORT_DEFAULT: AgentCliEffort = ReasoningEffort.MEDIUM;

/** Value facts of the settings rows: the schema with its default, and the picker labels. */
export const CLAUDE_AGENT_MODEL_SETTING = {
  schema: ClaudeAgentModelSchema.prefault(CLAUDE_AGENT_DEFAULT_MODEL),
  enumLabels: claudeCodeModels.labels,
};
export const CODEX_MODEL_SETTING = {
  schema: CodexModelSchema.prefault(CODEX_DEFAULT_MODEL),
  enumLabels: codexModels.labels,
};
export const AGENT_CLI_EFFORT_SETTING = {
  schema: AgentCliEffortSchema.prefault(AGENT_CLI_EFFORT_DEFAULT),
  enumLabels: ['Low', 'Medium', 'High', 'Extra high', 'Maximum'],
};

// ============================================================================
// Codex
// ============================================================================

/** Valid Codex sandbox modes. */
export const CodexSandboxModeSchema = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
export type CodexSandboxMode = z.infer<typeof CodexSandboxModeSchema>;

export const CODEX_SANDBOX_MODE_DEFAULT: CodexSandboxMode = 'workspace-write';

/** Valid Codex approval policies. */
export const CodexApprovalPolicySchema = z.enum([
  'never',
  'on-request',
  'untrusted',
  'on-failure',
]);
export type CodexApprovalPolicy = z.infer<typeof CodexApprovalPolicySchema>;

export const CODEX_APPROVAL_POLICY_DEFAULT: CodexApprovalPolicy = 'never';

// ============================================================================
// Claude Code
// ============================================================================

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

export const BASH_APPROVAL_CONFIG_KEY = 'texra.toolUse.requireBashApproval';
