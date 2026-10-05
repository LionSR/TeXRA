/**
 * The setting rows of the two external coding-agent plugins, `codex` and
 * `claude-agent`: TeXRA's catalog lists them (`./texraSettings`) and their
 * dashboard cards render them inline (`@tools/pluginCards`). They live here,
 * in a browser-safe module, because the settings view's webview renders them.
 */

// Local imports
import {
  AGENT_CLI_EFFORT_SETTING,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  CLAUDE_AGENT_MODEL_SETTING,
  ClaudeAgentPermissionModeSchema,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_MODEL_SETTING,
  CODEX_SANDBOX_MODE_DEFAULT,
  CodexApprovalPolicySchema,
  CodexSandboxModeSchema,
} from '@shared/schemas';
import {
  surfacedSetting,
  type PluginSettingRow,
  type SurfacedSettingEntry,
  type SurfacedSettingInput,
} from '@shared/state/stateSettings';

/** The `codex` plugin's repository-scoped keys. */
export enum CodexStateKey {
  MODEL = 'texra.codexModel',
  SANDBOX_MODE = 'texra.codexSandboxMode',
  REASONING_EFFORT = 'texra.codexReasoningEffort',
  APPROVAL_POLICY = 'texra.codexApprovalPolicy',
}

/** The `claude-agent` plugin's repository-scoped keys. */
export enum ClaudeAgentStateKey {
  MODEL = 'texra.claudeAgentModel',
  PERMISSION_MODE = 'texra.claudeAgentPermissionMode',
  EFFORT = 'texra.claudeAgentEffort',
}

/** An external coding agent's row: repo-scoped, on the approval tab and in `/config`. */
function agentCliSetting(
  entry: Omit<SurfacedSettingInput, 'category' | 'slot' | 'surfaces'>,
): SurfacedSettingEntry {
  return surfacedSetting({
    ...entry,
    category: 'ai-agents',
    slot: 'repoState',
    surfaces: { settingsView: 'approval', cliConfig: true },
  });
}

/** The `codex` plugin's rows, in its card's order. */
export const CODEX_SETTINGS: readonly PluginSettingRow[] = [
  {
    label: 'Model',
    row: agentCliSetting({
      key: CodexStateKey.MODEL,
      ...CODEX_MODEL_SETTING,
      title: 'Codex model',
      description: 'OpenAI model selected for Codex agent sessions.',
    }),
  },
  {
    label: 'Sandbox mode',
    row: agentCliSetting({
      key: CodexStateKey.SANDBOX_MODE,
      schema: CodexSandboxModeSchema.prefault(CODEX_SANDBOX_MODE_DEFAULT),
      title: 'Codex sandbox mode',
      description: 'Filesystem access mode used when TeXRA launches Codex.',
      enumLabels: ['Read-only', 'Workspace write', 'Full access'],
    }),
  },
  {
    label: 'Reasoning effort',
    row: agentCliSetting({
      key: CodexStateKey.REASONING_EFFORT,
      ...AGENT_CLI_EFFORT_SETTING,
      title: 'Codex reasoning effort',
      description:
        'Reasoning effort for Codex runs, up to what the model takes.',
    }),
  },
  {
    label: 'Approval policy',
    row: agentCliSetting({
      key: CodexStateKey.APPROVAL_POLICY,
      schema: CodexApprovalPolicySchema.prefault(CODEX_APPROVAL_POLICY_DEFAULT),
      title: 'Codex approval policy',
      description: 'When Codex should ask for approval before risky actions.',
      enumLabels: [
        'Auto approve',
        'Ask when requested',
        'Ask for untrusted',
        'Ask on failure',
      ],
    }),
  },
];

/** The `claude-agent` plugin's rows, in its card's order. */
export const CLAUDE_AGENT_SETTINGS: readonly PluginSettingRow[] = [
  {
    label: 'Model',
    row: agentCliSetting({
      key: ClaudeAgentStateKey.MODEL,
      ...CLAUDE_AGENT_MODEL_SETTING,
      title: 'Claude Code model',
      description: 'Claude model selected for Claude Code agent sessions.',
    }),
  },
  {
    label: 'Reasoning effort',
    row: agentCliSetting({
      key: ClaudeAgentStateKey.EFFORT,
      ...AGENT_CLI_EFFORT_SETTING,
      title: 'Claude Code reasoning effort',
      description:
        'Reasoning effort for Claude Code, up to what the model takes.',
    }),
  },
  {
    label: 'Permission mode',
    row: agentCliSetting({
      key: ClaudeAgentStateKey.PERMISSION_MODE,
      schema: ClaudeAgentPermissionModeSchema.prefault(
        CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
      ),
      title: 'Claude Code permission mode',
      description: 'Permission policy used by Claude Code agent sessions.',
      enumLabels: [
        'Prompt for risky actions',
        'Auto-accept edits',
        'Bypass all (dangerous)',
        'Plan only (read-only)',
      ],
    }),
  },
];
