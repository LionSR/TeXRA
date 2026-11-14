/**
 * Where TeXRA shows a setting. The harness catalog says what a setting is
 * (`SettingRow`: key, schema, slot, copy); this module says which of TeXRA's
 * settings UIs render it: the extension/desktop settings view, the CLI
 * `/config` panel and the Models tab's per-provider controls. TeXRA's own rows
 * carry their placement inline (`TexraSettingRow`); the harness's rows get
 * theirs from {@link HARNESS_ROW_SURFACES}, keyed by the row's key, which
 * `texraSettings.ts` joins onto the catalog. "Shown" is a placement and
 * nothing else.
 */

// Third-party imports
import { Schema } from 'effect';

// Local imports
import {
  AGENT_SKILLS_ENABLED_SETTING,
  APPROVAL_POLICY_SETTING,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  GOAL_MAX_COST_SETTING,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  type HarnessRowKey,
  type SettingRow,
  ALLOW_ORCHESTRATOR_KILL_SETTING,
  DASHSCOPE_REGION_SETTING,
  DETACH_SUBAGENTS_ON_STOP_SETTING,
  DISABLED_SKILLS_SETTING,
  DISABLED_SKILL_SOURCES_SETTING,
  GIT_AUTHOR_EMAIL_SETTING,
  GIT_AUTHOR_NAME_SETTING,
  GIT_MARK_COMMITS_SETTING,
  GIT_WORKTREE_SUPPORT_SETTING,
  GLM_CODING_PLAN_SETTING,
  GLM_REGION_SETTING,
  GOOGLE_INTERACTIONS_SERVER_STATE_SETTING,
  HELPER_MODEL_SETTING,
  KIMI_CODE_PREFER_SETTING,
  MEMORY_ENABLED_SETTING,
  MINIMAX_REGION_SETTING,
  MOONSHOT_REGION_SETTING,
  OPENAI_FAST_TIER_SETTING,
  SCRIPT_ONLY_SETTING,
  TOOL_PATH_PROTECTION_SETTING,
  WEBSOCKET_OPENAI_SETTING,
  CHATGPT_PREFER_SUBSCRIPTION_SETTING,
  DEBUG_MODE_SETTING,
  GIT_COMMITS_TO_SHOW_SETTING,
  GLM_ENDPOINT_SETTING,
  GOAL_STRATEGY_SETTING,
  GOOGLE_BACKGROUND_RESPONSES_SETTING,
  MAX_IMAGE_DIMENSION_SETTING,
  SAVE_MODEL_IO_SETTING,
  SOX_PATH_SETTING,
  XAI_PREFER_SUBSCRIPTION_SETTING,
} from '@texra-ai/harness/schemas';
import type { SettingsViewSnapshot } from '@texra/shared/settingsView/settingsViewMessages';

/**
 * One provider's control in the Models tab. `label` and `description` default
 * to the row's `title` and `description`, so a toggle whose Models-tab copy is
 * the row's own is written once.
 */
interface ModelsTabSurface {
  /** Canonical provider id whose expanded settings show this control. */
  readonly provider: string;
  readonly label?: string;
  readonly description?: string;
  readonly warning?: string;
  readonly warningUrl?: string;
  readonly warningUrlLabel?: string;
}

/** The TeXRA UIs that render a row. */
interface SettingSurfaces {
  /**
   * Rendered by the extension/desktop settings view; the value names the
   * snapshot rebroadcast after a write. Presence also makes the row writable
   * through the generic `UPDATE_STATE_SETTING` boundary.
   */
  readonly settingsView?: SettingsViewSnapshot;
  /** Listed as an editable row in the CLI `/config` panel. */
  readonly cliConfig?: true;
  /** Shown as a per-provider toggle in the Models tab. */
  readonly models?: readonly ModelsTabSurface[];
}

/** Consequences of writing a row, applied by the settings write handlers. */
interface SettingWriteEffects {
  /**
   * Writing the row changes which models are available or how they route, so
   * hosts must recompute their cached model options.
   */
  readonly invalidatesModelOptions?: true;
}

/**
 * The groups TeXRA's settings UIs sort a placed row under; the CLI `/config`
 * panel labels each (`configCategories.ts`).
 */
export const SettingCategorySchema = Schema.Literals([
  'git',
  'agents',
  'ai-agents',
  'documents',
  'model',
  'latex',
  'latexdiff',
  'tools',
  'privacy',
]);
export type SettingCategory = typeof SettingCategorySchema.Type;

/** Where and how TeXRA shows a row: its group, the UIs that render it, and
 *  what a write entails. */
interface Placement {
  readonly category: SettingCategory;
  readonly surfaces: SettingSurfaces;
  /** Write-time consequences, read by the settings write handlers. */
  readonly onWrite?: SettingWriteEffects;
  /**
   * The CLI `/config` panel edits the row in this existing list form (the
   * skills form) instead of the scalar read/write accessor.
   */
  readonly openForm?: string;
}

/** A catalog row at least one TeXRA UI renders, with where and how. */
export type TexraSettingRow<A = unknown> = SettingRow<A> & Placement;

/** A row the extension/desktop settings view owns the write path for. */
export type SettingsViewRow = TexraSettingRow & {
  readonly surfaces: SettingSurfaces & {
    readonly settingsView: SettingsViewSnapshot;
  };
};

type Surfaces = Pick<Placement, 'surfaces' | 'openForm'>;

const AGENTS_AND_CLI: Surfaces = {
  surfaces: { settingsView: 'agents', cliConfig: true },
};
const APPROVAL_AND_CLI: Surfaces = {
  surfaces: { settingsView: 'approval', cliConfig: true },
};
const GIT_AUTHOR_AND_CLI: Surfaces = {
  surfaces: { settingsView: 'git-author', cliConfig: true },
};
const SKILLS_FORM: Surfaces = {
  openForm: 'skills',
  surfaces: { settingsView: 'skills', cliConfig: true },
};
const PROVIDER_ENDPOINT: Placement = {
  category: 'model',
  surfaces: { settingsView: 'profile', cliConfig: true },
};

/** A provider toggle on the profile page, in `/config` and in the Models tab. */
function providerToggle(
  model: ModelsTabSurface,
  onWrite?: SettingWriteEffects,
): Placement {
  return {
    category: 'model',
    ...(onWrite && { onWrite }),
    surfaces: { settingsView: 'profile', cliConfig: true, models: [model] },
  };
}

/**
 * Where TeXRA shows each harness row, by the row's key, or `null` for a row
 * no TeXRA UI shows. Total over the harness's rows, so a row added without a
 * decision here, or a placement for a key no row has, fails to compile.
 */
export const HARNESS_ROW_SURFACES: Readonly<
  Record<HarnessRowKey, Placement | null>
> = {
  // --- Config-file-backed rows ---------------------------------------------
  [CHILD_RUN_CONCURRENCY_BUDGET_SETTING.key]: {
    category: 'agents',
    ...AGENTS_AND_CLI,
  },
  [GOAL_MAX_COST_SETTING.key]: { category: 'tools', ...APPROVAL_AND_CLI },
  // Set in the global `config.json`, as the cap it checks is.
  [GOAL_STRATEGY_SETTING.key]: null,
  [GOOGLE_INTERACTIONS_SERVER_STATE_SETTING.key]: {
    category: 'model',
    surfaces: {
      settingsView: 'profile',
      models: [{ provider: 'google' }],
    },
  },
  // A transport knob, set in the global `config.json`.
  [GOOGLE_BACKGROUND_RESPONSES_SETTING.key]: null,
  [OPENAI_FAST_TIER_SETTING.key]: providerToggle({ provider: 'openai' }),
  [MODEL_COMPACTION_THRESHOLD_SETTING.key]: {
    category: 'model',
    ...AGENTS_AND_CLI,
  },
  [MODEL_RETRY_MAX_ATTEMPTS_SETTING.key]: {
    category: 'model',
    ...AGENTS_AND_CLI,
  },
  // The subscription switches have their own controls on the Models page.
  [CHATGPT_PREFER_SUBSCRIPTION_SETTING.key]: null,
  [XAI_PREFER_SUBSCRIPTION_SETTING.key]: null,
  // The `agents` snapshot controls rebroadcast routing, not tab placement; the
  // Subscriptions control reuses it because no subscriptions snapshot exists.
  [CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.key]: {
    category: 'model',
    ...AGENTS_AND_CLI,
    onWrite: { invalidatesModelOptions: true },
  },
  // Written by the setup assistant's `update_config`, read by their tools.
  [MAX_IMAGE_DIMENSION_SETTING.key]: null,
  [GIT_COMMITS_TO_SHOW_SETTING.key]: null,
  [SOX_PATH_SETTING.key]: null,
  // Debugging switches, set in `config.json`.
  [DEBUG_MODE_SETTING.key]: null,
  [SAVE_MODEL_IO_SETTING.key]: null,
  [AGENT_SKILLS_ENABLED_SETTING.key]: {
    category: 'tools',
    surfaces: { settingsView: 'skills', cliConfig: true },
  },
  [APPROVAL_POLICY_SETTING.key]: { category: 'tools', ...APPROVAL_AND_CLI },

  // --- Git ------------------------------------------------------------------
  [GIT_MARK_COMMITS_SETTING.key]: { category: 'git', ...GIT_AUTHOR_AND_CLI },
  [GIT_AUTHOR_NAME_SETTING.key]: { category: 'git', ...GIT_AUTHOR_AND_CLI },
  [GIT_AUTHOR_EMAIL_SETTING.key]: { category: 'git', ...GIT_AUTHOR_AND_CLI },
  [GIT_WORKTREE_SUPPORT_SETTING.key]: {
    category: 'git',
    ...GIT_AUTHOR_AND_CLI,
  },

  // --- Agent coordination -----------------------------------------------------
  [ALLOW_ORCHESTRATOR_KILL_SETTING.key]: {
    category: 'agents',
    ...AGENTS_AND_CLI,
  },
  [DETACH_SUBAGENTS_ON_STOP_SETTING.key]: {
    category: 'agents',
    ...AGENTS_AND_CLI,
  },

  // --- Memory and code mode --------------------------------------------------
  // Memory has no `/config` row; script-only tools have no settings-view row.
  [MEMORY_ENABLED_SETTING.key]: {
    category: 'tools',
    surfaces: { settingsView: 'memory' },
  },
  [SCRIPT_ONLY_SETTING.key]: {
    category: 'agents',
    surfaces: { cliConfig: true },
  },

  // --- Providers --------------------------------------------------------------
  [WEBSOCKET_OPENAI_SETTING.key]: providerToggle({
    provider: 'openai',
    label: 'WebSocket transport',
    description:
      'Use a persistent WebSocket connection for lower-latency tool-use loops. Requires direct OpenAI API (not compatible with custom endpoints).',
  }),
  'endpoint.openai': PROVIDER_ENDPOINT,
  'endpoint.anthropic': PROVIDER_ENDPOINT,
  'endpoint.google': PROVIDER_ENDPOINT,
  'endpoint.xai': PROVIDER_ENDPOINT,
  'endpoint.deepseek': PROVIDER_ENDPOINT,
  'endpoint.moonshot': PROVIDER_ENDPOINT,
  'endpoint.dashscope': PROVIDER_ENDPOINT,
  'endpoint.minimax': PROVIDER_ENDPOINT,
  [GLM_ENDPOINT_SETTING.key]: PROVIDER_ENDPOINT,
  'endpoint.meta': PROVIDER_ENDPOINT,
  [HELPER_MODEL_SETTING.key]: {
    category: 'model',
    surfaces: { settingsView: 'models' },
  },
  [KIMI_CODE_PREFER_SETTING.key]: providerToggle(
    { provider: 'kimiCode' },
    { invalidatesModelOptions: true },
  ),
  [MOONSHOT_REGION_SETTING.key]: providerToggle({
    provider: 'moonshot',
    warning:
      'A platform.moonshot.cn key does not work with the international endpoint, and vice versa.',
    warningUrl: 'https://platform.moonshot.ai/console',
    warningUrlLabel: 'International console',
  }),
  [DASHSCOPE_REGION_SETTING.key]: providerToggle({ provider: 'dashscope' }),
  [MINIMAX_REGION_SETTING.key]: providerToggle({
    provider: 'minimax',
    warning:
      'International keys do not work with the China endpoint, and vice versa. Coding Plan keys are also region-specific.',
    warningUrl: 'https://platform.minimax.io/',
    warningUrlLabel: 'Get API key',
  }),
  [GLM_REGION_SETTING.key]: providerToggle({
    provider: 'glm',
    warningUrl: 'https://open.bigmodel.cn/',
    warningUrlLabel: 'BigModel console',
  }),
  [GLM_CODING_PLAN_SETTING.key]: providerToggle(
    {
      provider: 'glm',
      warningUrl: 'https://z.ai/subscribe',
      warningUrlLabel: 'Subscribe',
    },
    { invalidatesModelOptions: true },
  ),

  // --- Skills and tool paths ---------------------------------------------------
  [DISABLED_SKILLS_SETTING.key]: { category: 'tools', ...SKILLS_FORM },
  [DISABLED_SKILL_SOURCES_SETTING.key]: { category: 'tools', ...SKILLS_FORM },
  [TOOL_PATH_PROTECTION_SETTING.key]: {
    category: 'tools',
    ...APPROVAL_AND_CLI,
  },
};
