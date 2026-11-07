/**
 * The setting rows of the two external coding-agent plugins, `codex` and
 * `claude-agent`: TeXRA's catalog lists them (`./texraSettings`) and their
 * dashboard cards render them inline (`PluginCard.settings`). They live here,
 * in a browser-safe module, because the settings view's webview renders them.
 */

// Local imports
import {
  AGENT_CLI_EFFORT_VALUES,
  type AgentCliEffort,
  CLAUDE_AGENT_MODEL_VALUES,
  CODEX_MODEL_VALUES,
} from '@texra/shared/agentCliSettings';
import { type PluginSettingRow } from '@texra/shared/settingsView/settingRows';
import type { TexraSettingRow } from '@texra/shared/settingsView/settingSurfaces';

/** Where an external coding agent's row lives and shows: repo-scoped, on the
 *  approval tab and in `/config`. */
const AGENT_CLI_PLACEMENT = {
  category: 'ai-agents',
  slot: 'repoState',
  surfaces: { settingsView: 'approval', cliConfig: true },
} as const;

export const CODEX_MODEL_SETTING = {
  key: 'codexModel',
  ...CODEX_MODEL_VALUES,
  title: 'Codex model',
  description: 'OpenAI model selected for Codex agent sessions.',
  ...AGENT_CLI_PLACEMENT,
} as const satisfies TexraSettingRow<string>;

export const CODEX_REASONING_EFFORT_SETTING = {
  key: 'codexReasoningEffort',
  ...AGENT_CLI_EFFORT_VALUES,
  title: 'Codex reasoning effort',
  description: 'Reasoning effort for Codex runs, up to what the model takes.',
  ...AGENT_CLI_PLACEMENT,
} as const satisfies TexraSettingRow<AgentCliEffort>;

export const CLAUDE_AGENT_MODEL_SETTING = {
  key: 'claudeAgentModel',
  ...CLAUDE_AGENT_MODEL_VALUES,
  title: 'Claude Code model',
  description: 'Claude model selected for Claude Code agent sessions.',
  ...AGENT_CLI_PLACEMENT,
} as const satisfies TexraSettingRow<string>;

export const CLAUDE_AGENT_EFFORT_SETTING = {
  key: 'claudeAgentEffort',
  ...AGENT_CLI_EFFORT_VALUES,
  title: 'Claude Code reasoning effort',
  description: 'Reasoning effort for Claude Code, up to what the model takes.',
  ...AGENT_CLI_PLACEMENT,
} as const satisfies TexraSettingRow<AgentCliEffort>;

/** The `codex` plugin's rows, in its card's order. */
export const CODEX_SETTINGS: readonly PluginSettingRow[] = [
  { label: 'Model', row: CODEX_MODEL_SETTING },
  { label: 'Reasoning effort', row: CODEX_REASONING_EFFORT_SETTING },
];

/** The `claude-agent` plugin's rows, in its card's order. */
export const CLAUDE_AGENT_SETTINGS: readonly PluginSettingRow[] = [
  { label: 'Model', row: CLAUDE_AGENT_MODEL_SETTING },
  { label: 'Reasoning effort', row: CLAUDE_AGENT_EFFORT_SETTING },
];
