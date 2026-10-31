/**
 * Where TeXRA shows a setting. The harness catalog says what a setting is
 * (`StateSettingEntry`: key, schema, slot, copy); this module says which of
 * TeXRA's settings UIs render it: the extension/desktop settings view, the CLI
 * `/config` panel and the Models tab's per-provider controls. TeXRA's own rows
 * carry their placement inline (`TexraSettingRow`); the harness's rows get
 * theirs from {@link HARNESS_ROW_SURFACES}, keyed by setting key, which
 * `texraSettings.ts` joins onto the catalog.
 */

// Local imports
import {
  AGENT_SKILLS_CONFIG_KEY,
  APPROVAL_POLICY_CONFIG_KEY,
  BASH_APPROVAL_CONFIG_KEY,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  GlobalStateKey,
  GOAL_MAX_COST_SETTING,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  PROVIDER_ENDPOINT_STATE_ENTRIES,
  RESUME_ON_OPEN_SETTING,
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
  WorkspaceStateKey,
  type StateSettingEntry,
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

/** A catalog row at least one TeXRA UI renders, with where and how. */
export type TexraSettingRow = StateSettingEntry & {
  readonly description: string;
  readonly category: string;
  readonly surfaces: SettingSurfaces;
  /** Write-time consequences, read by the settings write handlers. */
  readonly onWrite?: SettingWriteEffects;
  /**
   * The CLI `/config` panel edits the row in this existing list form (the
   * skills form) instead of the scalar read/write accessor.
   */
  readonly openForm?: string;
};

/** A row the extension/desktop settings view owns the write path for. */
export type SettingsViewRow = TexraSettingRow & {
  readonly surfaces: SettingSurfaces & {
    readonly settingsView: SettingsViewSnapshot;
  };
};

type Placement = Pick<TexraSettingRow, 'surfaces' | 'onWrite' | 'openForm'>;

const AGENTS_AND_CLI: Placement = {
  surfaces: { settingsView: 'agents', cliConfig: true },
};
const APPROVAL_AND_CLI: Placement = {
  surfaces: { settingsView: 'approval', cliConfig: true },
};
const APPROVAL_ONLY: Placement = { surfaces: { settingsView: 'approval' } };
const PROFILE_AND_CLI: Placement = {
  surfaces: { settingsView: 'profile', cliConfig: true },
};
const GIT_AUTHOR_AND_CLI: Placement = {
  surfaces: { settingsView: 'git-author', cliConfig: true },
};
const MODELS_ONLY: Placement = { surfaces: { settingsView: 'models' } };
const SKILLS_FORM: Placement = {
  openForm: 'skills',
  surfaces: { settingsView: 'skills', cliConfig: true },
};

/** A provider toggle on the profile page, in `/config` and in the Models tab. */
function providerToggle(
  model: ModelsTabSurface,
  onWrite?: SettingWriteEffects,
): Placement {
  return {
    ...(onWrite && { onWrite }),
    surfaces: { settingsView: 'profile', cliConfig: true, models: [model] },
  };
}

/**
 * Where TeXRA shows each harness row, by setting key. A key no harness row
 * has, and a harness row with display copy but no entry here, both fail at
 * startup (`texraSettings.ts`), so a placement cannot be lost silently.
 */
export const HARNESS_ROW_SURFACES: Readonly<Record<string, Placement>> = {
  // --- Config-file-backed rows ---------------------------------------------
  [CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY]: AGENTS_AND_CLI,
  [RESUME_ON_OPEN_SETTING.configKey]: APPROVAL_AND_CLI,
  [GOAL_MAX_COST_SETTING.configKey]: APPROVAL_AND_CLI,
  'model.useGoogleInteractionsServerState': {
    surfaces: {
      settingsView: 'profile',
      models: [
        {
          provider: 'google',
          label: 'Server-side conversation state',
          description:
            "Store Interactions conversation state on Google's servers (send only the new turn each round; Google retains the conversation for a limited period to enable chaining). Disable to keep conversations off Google's servers and resend the full transcript each round.",
        },
      ],
    },
  },
  [MODEL_COMPACTION_THRESHOLD_SETTING.configKey]: AGENTS_AND_CLI,
  [MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey]: AGENTS_AND_CLI,
  // The `agents` snapshot controls rebroadcast routing, not tab placement; the
  // Subscriptions control reuses it because no subscriptions snapshot exists.
  [CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.configKey]: {
    ...AGENTS_AND_CLI,
    onWrite: { invalidatesModelOptions: true },
  },
  [AGENT_SKILLS_CONFIG_KEY]: {
    surfaces: { settingsView: 'skills', cliConfig: true },
  },
  [TOOL_EDIT_APPROVAL_CONFIG_KEY]: APPROVAL_ONLY,
  [BASH_APPROVAL_CONFIG_KEY]: APPROVAL_ONLY,
  [APPROVAL_POLICY_CONFIG_KEY]: APPROVAL_AND_CLI,

  // --- Git ------------------------------------------------------------------
  [WorkspaceStateKey.GIT_MARK_COMMITS]: GIT_AUTHOR_AND_CLI,
  [WorkspaceStateKey.GIT_AUTHOR_NAME]: GIT_AUTHOR_AND_CLI,
  [WorkspaceStateKey.GIT_AUTHOR_EMAIL]: GIT_AUTHOR_AND_CLI,
  [WorkspaceStateKey.GIT_WORKTREE_SUPPORT]: GIT_AUTHOR_AND_CLI,

  // --- Agent coordination -----------------------------------------------------
  [GlobalStateKey.ALLOW_ORCHESTRATOR_KILL]: AGENTS_AND_CLI,
  [GlobalStateKey.DETACH_SUBAGENTS_ON_STOP]: AGENTS_AND_CLI,

  // --- Memory and code mode --------------------------------------------------
  // Memory has no `/config` row; script-only tools have no settings-view row.
  [GlobalStateKey.MEMORY_ENABLED]: { surfaces: { settingsView: 'memory' } },
  [GlobalStateKey.SCRIPT_ONLY]: { surfaces: { cliConfig: true } },

  // --- Providers --------------------------------------------------------------
  [GlobalStateKey.WEBSOCKET_OPENAI]: providerToggle({
    provider: 'openai',
    label: 'WebSocket transport',
    description:
      'Use a persistent WebSocket connection for lower-latency tool-use loops. Requires direct OpenAI API (not compatible with custom endpoints).',
  }),
  ...Object.fromEntries(
    PROVIDER_ENDPOINT_STATE_ENTRIES.map(({ endpointKey }) => [
      endpointKey,
      PROFILE_AND_CLI,
    ]),
  ),
  [GlobalStateKey.HELPER_MODEL]: MODELS_ONLY,
  [GlobalStateKey.PREFER_SHORT_MODEL_NAMES]: MODELS_ONLY,
  [GlobalStateKey.KIMI_CODE_PREFER]: providerToggle(
    { provider: 'kimiCode' },
    { invalidatesModelOptions: true },
  ),
  'moonshot.useChina': providerToggle({
    provider: 'moonshot',
    warning:
      'A platform.moonshot.cn key does not work with the international endpoint, and vice versa.',
    warningUrl: 'https://platform.moonshot.ai/console',
    warningUrlLabel: 'International console',
  }),
  'dashscope.useChina': providerToggle({ provider: 'dashscope' }),
  'minimax.useChina': providerToggle({
    provider: 'minimax',
    warning:
      'International keys do not work with the China endpoint, and vice versa. Coding Plan keys are also region-specific.',
    warningUrl: 'https://platform.minimax.io/',
    warningUrlLabel: 'Get API key',
  }),
  'glm.useChina': providerToggle({
    provider: 'glm',
    warningUrl: 'https://open.bigmodel.cn/',
    warningUrlLabel: 'BigModel console',
  }),
  [GlobalStateKey.GLM_CODING_PLAN]: providerToggle(
    {
      provider: 'glm',
      warningUrl: 'https://z.ai/subscribe',
      warningUrlLabel: 'Subscribe',
    },
    { invalidatesModelOptions: true },
  ),

  // --- Skills and tool paths ---------------------------------------------------
  [WorkspaceStateKey.DISABLED_SKILLS]: SKILLS_FORM,
  [WorkspaceStateKey.DISABLED_SKILL_SOURCES]: SKILLS_FORM,
  [WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED]: APPROVAL_AND_CLI,
};
