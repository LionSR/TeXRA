/**
 * The setting rows of the two external coding-agent plugins, `codex` and
 * `claude-agent`: TeXRA's catalog lists them (`./texraSettings`) and their
 * dashboard cards render them inline (`PluginCard.settings`). They live here,
 * in a browser-safe module, because the settings view's webview renders them.
 */

// Local imports
import {
  AGENT_CLI_EFFORT_SETTING,
  CLAUDE_AGENT_MODEL_SETTING,
  CODEX_MODEL_SETTING,
} from '@texra/shared/agentCliSettings';
import { type PluginSettingRow } from '@texra/shared/settingsView/settingRows';
import type { TexraSettingRow } from '@texra/shared/settingsView/settingSurfaces';

/** The `codex` plugin's repository-scoped keys. */
export const CodexStateKey = Object.freeze({
  MODEL: 'codexModel',
  REASONING_EFFORT: 'codexReasoningEffort',
} as const);
export type CodexStateKey = (typeof CodexStateKey)[keyof typeof CodexStateKey];

/** The `claude-agent` plugin's repository-scoped keys. */
export const ClaudeAgentStateKey = Object.freeze({
  MODEL: 'claudeAgentModel',
  EFFORT: 'claudeAgentEffort',
} as const);
export type ClaudeAgentStateKey =
  (typeof ClaudeAgentStateKey)[keyof typeof ClaudeAgentStateKey];

/** An external coding agent's row: repo-scoped, on the approval tab and in `/config`. */
function agentCliSetting(
  entry: Omit<TexraSettingRow, 'category' | 'slot' | 'surfaces'>,
): TexraSettingRow {
  return {
    ...entry,
    category: 'ai-agents',
    slot: 'repoState',
    surfaces: { settingsView: 'approval', cliConfig: true },
  } satisfies TexraSettingRow;
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
    label: 'Reasoning effort',
    row: agentCliSetting({
      key: CodexStateKey.REASONING_EFFORT,
      ...AGENT_CLI_EFFORT_SETTING,
      title: 'Codex reasoning effort',
      description:
        'Reasoning effort for Codex runs, up to what the model takes.',
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
];
