// Third-party imports
import { z } from 'zod';

// Local imports - shared constants & state keys
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_DEFAULT,
  TexraApprovalPolicySchema,
} from '@shared/approvalPolicy';
import { INCLUDED_ACCESS } from '@shared/copy/modelAccess';
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
  LATEX_FORMATTER_VALUES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latexConfig';
import {
  DEFAULT_HELPER_MODEL,
  PROVIDER_ENDPOINT_STATE_ENTRIES,
  PROVIDER_STATE_ENTRIES,
} from '@shared/constants/providers';
import {
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  ClaudeAgentEffortSchema,
  ClaudeAgentModelSchema,
  ClaudeAgentPermissionModeSchema,
  parseClaudeAgentModel,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
  CodexApprovalPolicySchema,
  CodexReasoningEffortSchema,
  CodexSandboxModeSchema,
} from '@shared/schemas/agentCliSettings';
import {
  CORE_SETTING_PATHS,
  CoreSettingsShape,
  type CoreSettingPath,
} from '@shared/schemas/coreSettings';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';

// ============================================================================
// Git defaults
// ============================================================================

export const DEFAULT_GIT_AUTHOR_NAME = 'texra-ai';
export const DEFAULT_GIT_AUTHOR_EMAIL = 'texra-ai@users.noreply.github.com';

/**
 * Default for `texra.git.markCommits` when the workspace has never
 * toggled the setting. Shared by the backend reader
 * (`readGitAuthorSettings`) and the frontend signal initializer
 * (`SettingsApp.gitMarkCommits`) so the Git tab doesn't flash the
 * wrong state on first paint before settings arrive.
 */
export const DEFAULT_GIT_MARK_COMMITS = true;

/**
 * Default for `texra.git.worktreeSupport` when the workspace has never toggled
 * it. Shared by the backend reader (`readGitAuthorSettingsFromState`) and the
 * state-settings catalog so the default lives in one place.
 */
export const DEFAULT_GIT_WORKTREE_SUPPORT = false;

/**
 * Keep file-oriented tools inside the active working directory unless the
 * user explicitly grants them access to arbitrary filesystem paths.
 */
export const DEFAULT_TOOL_PATH_PROTECTION_ENABLED = true;

// ============================================================================
// The one setting row
// ============================================================================

/**
 * Host-neutral catalog for every TeXRA setting a host can store, honor, or
 * render.
 *
 * One row answers all four questions that used to be answered in six places:
 *
 * - **`slots`** — where each host stores the value (`config` /
 *   `workspaceState` / `globalState`). Replaces the old `store` + `cliStore`
 *   pair and the caller-chosen slot in `readGitAuthorSettingsFromState`.
 * - **`honoredBy`** — whose *runtime* actually reads the key, with the reading
 *   file as evidence. Replaces `CLI_CORE_SETTING_PATHS`,
 *   `EXTENSION_ONLY_CORE_SETTING_PATHS`, and the reader-file registry that
 *   used to live in the guardrail suite as a third copy of the same knowledge.
 * - **`surfaces`** — which catalog-driven *UI* renders the row (settings view,
 *   CLI `/config`, the Models tab's per-provider controls). Replaces the
 *   display half of the old `hosts` field, `settingsViewSnapshot`, and the
 *   Models tab's own `PROVIDER_SETTINGS` catalog.
 * - **`onWrite`** — write-time consequences declared once, so the CLI form and
 *   the webview Models tab cannot enforce different rules (the Kimi Code /
 *   OpenRouter mutual exclusion used to exist on one path only).
 *
 * Everything downstream is a filter over these rows: the CLI unknown-key set,
 * the `/config` panel, the settings-view write gate, the Models tab rows, and
 * `settingSlot(entry, host)`.
 */

/** Hosts that may store, honor, or surface a setting. */
export type SettingHost = 'vscode' | 'cli' | 'desktop';

/** Storage slot a setting is read from / written to. */
export type SettingStore = 'config' | 'workspaceState' | 'globalState';

/** Storage slot per host. Absent means the host does not store the key. */
type SettingSlots = {
  readonly [H in SettingHost]?: SettingStore;
};

export type SettingsViewSnapshot =
  | 'agent-skills'
  | 'approval'
  | 'git-author'
  | 'latex'
  | 'models'
  | 'multi-agent'
  | 'profile'
  | 'telemetry';

interface CliRuntimeReachability {
  /**
   * Representative CLI command that reaches this setting after it has been set.
   * Placeholders are allowed when the command needs an installed agent/model.
   */
  readonly command: string;
  /**
   * Short manual trace from the CLI command surface to the honoring reader.
   * This is a review checklist item, not executable wiring.
   */
  readonly through: string;
}

/** Evidence that one host's runtime honors a setting. */
interface SettingHonor {
  /**
   * Repo-relative source file that reads the setting in this host's runtime.
   * Checked for existence by the guardrail suite, so a row can never claim a
   * host honors a key by naming a file that does not exist.
   */
  readonly reader: string;
  /**
   * Runtime-reachability trace. Required by the guardrail suite whenever the
   * row is also surfaced in the CLI `/config` panel, so an editable row is
   * never a silent no-op.
   */
  readonly reachability?: CliRuntimeReachability;
}

/** Which hosts' runtimes honor the setting, and how that is known. */
type SettingHonoredBy = {
  readonly [H in SettingHost]?: SettingHonor;
};

/** One provider's control group in the Models tab. */
export interface ModelsTabSurface {
  /** Canonical provider id whose expanded settings show this control. */
  readonly provider: string;
  readonly label: string;
  readonly description: string;
  readonly warning?: string;
  readonly warningUrl?: string;
  readonly warningUrlLabel?: string;
}

/** Catalog-driven UIs that render the row. Absent means no UI renders it. */
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

/** Consequences of writing a row, declared once for every write path. */
interface SettingWriteEffects {
  /**
   * Catalog keys forced to `false` when this row is written `true` — mutually
   * exclusive routes. Applied by `writeSetting`, so every host inherits it.
   */
  readonly disablesWhenEnabled?: readonly string[];
  /**
   * Writing the row changes which models are available or how they route, so
   * hosts must recompute their cached model options.
   */
  readonly invalidatesModelOptions?: true;
}

export interface StateSettingEntry {
  /**
   * Canonical `texra.*` key — identical to the config / WorkspaceState /
   * GlobalState slot the extension already uses.
   */
  readonly key: string;
  /**
   * Zod schema carrying both validation and the `.prefault()` default applied
   * when the key is absent. `schema.parse(undefined)` yields that default.
   */
  readonly schema: z.ZodType;
  /**
   * Optional normalization for legacy persisted values before schema validation.
   * Keep migration mappings in the domain parser referenced here, not the row.
   */
  readonly normalizePersisted?: (raw: unknown) => unknown;
  /** Short label for compact settings UIs; falls back to the stripped key. */
  readonly title?: string;
  /** Human-readable description, shared across every host that renders it. */
  readonly description?: string;
  /** Grouping label for settings UIs. Required once a UI renders the row. */
  readonly category?: string;
  /** Where each host stores the value. */
  readonly slots: SettingSlots;
  /** Persistence target for config-backed settings; workspace when omitted. */
  readonly configTarget?: 'global' | 'workspace';
  /** Which hosts' runtimes read the value, with the reading file as evidence. */
  readonly honoredBy: SettingHonoredBy;
  /** Which catalog-driven UIs render the row. */
  readonly surfaces?: SettingSurfaces;
  /** Write-time consequences applied by every write path. */
  readonly onWrite?: SettingWriteEffects;
  /**
   * Per-value descriptions for an enum setting, aligned 1:1 with the schema's
   * enum options (see {@link settingEnumOptions}). The option *values* are
   * derived from the schema, not restated here.
   */
  readonly enumDescriptions?: readonly string[];
  /** Display labels for enum options, aligned 1:1 with the schema options. */
  readonly enumLabels?: readonly string[];
  /**
   * Delegate editing to an existing list form (e.g. `ModelListForm`) instead of
   * the scalar read/write accessor.
   */
  readonly openForm?: string;
}

/** A row at least one catalog-driven UI renders, so display copy is present. */
export type SurfacedSettingEntry = StateSettingEntry & {
  readonly description: string;
  readonly category: string;
  readonly surfaces: SettingSurfaces;
};

/** A row the extension/desktop settings view owns the write path for. */
export type SettingsViewStateSettingEntry = SurfacedSettingEntry & {
  readonly surfaces: SettingSurfaces & {
    readonly settingsView: SettingsViewSnapshot;
  };
};

// ============================================================================
// Row builders
// ============================================================================

/** Every host stores the setting in the same slot. */
function sameSlot(store: SettingStore): SettingSlots {
  return { vscode: store, cli: store, desktop: store };
}

/**
 * Every host's runtime reads the setting through one host-neutral module in
 * `src/`, so all three honor it. `cliReachability` is supplied when the row is
 * also editable in `/config`.
 */
function everyHost(
  reader: string,
  cliReachability?: CliRuntimeReachability,
): SettingHonoredBy {
  return {
    vscode: { reader },
    desktop: { reader },
    cli: cliReachability
      ? { reader, reachability: cliReachability }
      : { reader },
  };
}

/**
 * Only the webview hosts honor the setting — the reader exists in shared code
 * but its effect has no headless counterpart. The row must say why.
 */
function webviewHosts(reader: string): SettingHonoredBy {
  return { vscode: { reader }, desktop: { reader } };
}

type SettingInput = Omit<StateSettingEntry, 'surfaces'> & {
  readonly surfaces?: undefined;
};

type SurfacedSettingInput = Omit<
  StateSettingEntry,
  'surfaces' | 'description' | 'category'
> & {
  readonly description: string;
  readonly category: string;
  readonly surfaces: SettingSurfaces;
};

/** A row no catalog-driven UI renders: storage and runtime facts only. */
function setting(entry: SettingInput): StateSettingEntry {
  return entry;
}

/**
 * A row at least one settings UI renders. Display copy is required at the call
 * site, so a rendered row can never fall back to an empty label.
 */
function surfacedSetting(entry: SurfacedSettingInput): SurfacedSettingEntry {
  return entry;
}

// ============================================================================
// Core (config-tree) rows
// ============================================================================

/**
 * The schema leaf for a dotted Core setting path, resolved from
 * {@link CoreSettingsShape} rather than restated per row. Throws loudly on a
 * path that does not resolve — a renamed schema group must not degrade into a
 * row with no validation.
 */
function coreLeafSchema(path: CoreSettingPath): z.ZodType {
  const [head, ...rest] = path.split('.');
  let node: unknown = (CoreSettingsShape as Record<string, unknown>)[
    head as string
  ];
  for (const segment of rest) {
    const group = node instanceof z.ZodPrefault ? node.unwrap() : node;
    if (!(group instanceof z.ZodObject)) {
      throw new Error(`Core setting path "${path}" has no schema group`);
    }
    node = (group.shape as Record<string, unknown>)[segment];
  }
  if (!(node instanceof z.ZodType)) {
    throw new Error(`Core setting path "${path}" has no schema leaf`);
  }
  return node;
}

/** The schema's own `.describe()` copy, used when a row adds no editorial one. */
function schemaDescription(schema: z.ZodType): string {
  const inner: z.ZodType =
    schema instanceof z.ZodPrefault ? (schema.unwrap() as z.ZodType) : schema;
  const described = inner.description ?? schema.description;
  if (described === undefined) {
    throw new Error('Core setting schema carries no description');
  }
  return described;
}

type CoreRowSpec = Omit<
  StateSettingEntry,
  'key' | 'schema' | 'slots' | 'description'
> & {
  /** Editorial copy for rendered rows; the schema's own text otherwise. */
  readonly description?: string;
};

const REPLACEMENT_ENGINE_READER = 'src/replacement/engine.ts';

/**
 * Every Core setting path, keyed by path so the record is exhaustive by
 * construction — adding a leaf to `CoreSettingsShape` without filing its
 * honoring hosts is a type error, which is what the deleted
 * `_AssertEveryCorePathClassified` guard used to check against two hand-kept
 * path lists.
 *
 * All three hosts read `.texra/config.json`, so the slot is uniform; the rows
 * differ only in who honors them and which UI renders them. Order within the
 * `model.*` block is the Models tab's control order.
 */
const CORE_SETTING_ROWS: Record<CoreSettingPath, CoreRowSpec> = {
  'agentOutputs.autoOpenFinal': {
    honoredBy: everyHost('src/agent/runtime/selectAutoOpenFinalOutput.ts'),
  },
  childRunConcurrencyBudget: {
    title: 'Child-run concurrency budget',
    category: 'multi-agent',
    honoredBy: everyHost('src/agent/runtime/childRunBudget.ts'),
    surfaces: { settingsView: 'multi-agent' },
  },
  'goal.enabled': {
    honoredBy: everyHost('src/tools/goal/goalFeatureFlag.ts'),
  },
  'model.gpt5ReasoningSummary': {
    title: 'GPT-5 reasoning summary',
    category: 'model',
    honoredBy: everyHost(
      'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
    ),
    surfaces: {
      settingsView: 'profile',
      models: [
        {
          provider: 'openai',
          label: 'GPT-5 reasoning summary',
          description:
            'Request reasoning summaries from GPT-5 models. Only available on OpenAI API Tier 3+.',
          warning:
            'New accounts with $20 credit are typically Tier 1 and will hit rate limits.',
          warningUrl:
            'https://platform.openai.com/settings/organization/billing/overview',
          warningUrlLabel: 'Check your tier',
        },
      ],
    },
  },
  'model.useOpenAIResponsesAPI': {
    title: 'Use the Responses API',
    category: 'model',
    honoredBy: everyHost('src/agent/runtime/ModelFactory.ts'),
    surfaces: {
      settingsView: 'profile',
      models: [
        {
          provider: 'openai',
          label: 'Use the Responses API',
          description:
            'Use the OpenAI Responses API instead of Chat Completions when available.',
        },
      ],
    },
  },
  'model.useGoogleInteractionsServerState': {
    title: 'Server-side conversation state',
    category: 'model',
    honoredBy: everyHost(
      'src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts',
    ),
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
  'model.useBackgroundResponses': {
    title: 'Background responses',
    category: 'model',
    honoredBy: everyHost(
      'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
    ),
    surfaces: {
      settingsView: 'profile',
      models: [
        {
          provider: 'openai',
          label: 'Background responses',
          description:
            'Handle long-running generations (>10 min) via polling to prevent timeouts. Adds polling overhead.',
        },
        {
          provider: 'google',
          label: 'Background responses',
          description:
            'Run long-running workflow generations as background Interactions (submit + poll) to avoid timeouts. Requires server-side conversation state; models that do not support it fall back automatically.',
        },
      ],
    },
  },
  'model.openaiParallelToolCalls': {
    title: 'Parallel tool calls',
    category: 'model',
    honoredBy: everyHost(
      'src/agent/modelHandlers/openai/modelHandlerOpenAI.ts',
    ),
    surfaces: {
      settingsView: 'profile',
      models: [
        {
          provider: 'openai',
          label: 'Parallel tool calls',
          description:
            'Allow the model to call multiple tools in parallel. On by default; disable for models that require sequential execution.',
        },
      ],
    },
  },
  'model.compactionThresholdPercent': {
    honoredBy: everyHost('src/agent/modelHandlers/ModelHandler.ts'),
  },
  'model.retry.maxAttempts': {
    honoredBy: everyHost('src/agent/core/flows/ModelInvocationNode.ts'),
  },
  // Thin provider modules own the public prefer-switch surface; the shared
  // factory in subscriptionPreference.ts is not a separate consumer key.
  'chatgptCodex.preferSubscription': {
    honoredBy: everyHost('src/model/codex/codexPreference.ts'),
  },
  'xaiGrok.preferSubscription': {
    honoredBy: everyHost('src/model/xai/xaiPreference.ts'),
  },
  maxImageDimension: {
    honoredBy: everyHost('src/utils/media/img.ts'),
  },
  'bib.defaultPath': {
    honoredBy: everyHost('src/tools/latex/ExtractBibliographyTool.ts'),
  },
  'bib.zoteroPort': {
    honoredBy: everyHost('src/tools/zotero/bbtClient.ts'),
  },
  'latex.latexindentConfig': {
    honoredBy: everyHost('src/latex/formatter/latexindentpt.ts'),
  },
  'latex.texfmtConfig': {
    honoredBy: everyHost('src/latex/formatter/texfmt.ts'),
  },
  'latex.tikzInputDirectory': {
    honoredBy: everyHost('src/latex/texTools.ts'),
  },
  'latex.includeWorkspaceInTexinputs': {
    honoredBy: everyHost('src/latex/texTools.ts'),
  },
  'latex.tikzTemplate': {
    honoredBy: everyHost('src/latex/TikzPictureManager.ts'),
  },
  'latex.wrapCritiqueInAlign': {
    title: 'Wrap criticism in align environments',
    description:
      'Wrap bare criticism and comment commands inside align environments with intertext.',
    category: 'latex',
    honoredBy: everyHost(REPLACEMENT_ENGINE_READER),
    surfaces: { settingsView: 'latex' },
  },
  'latex.enabledReplacements': {
    title: 'Literal replacement groups',
    description: 'Enabled groups of direct LaTeX cleanup replacements.',
    category: 'latex',
    honoredBy: everyHost(REPLACEMENT_ENGINE_READER),
    surfaces: { settingsView: 'latex' },
  },
  'latex.enabledReplacementsRegex': {
    title: 'Pattern replacement groups',
    description: 'Enabled groups of pattern-based LaTeX cleanup replacements.',
    category: 'latex',
    honoredBy: everyHost(REPLACEMENT_ENGINE_READER),
    surfaces: { settingsView: 'latex' },
  },
  'latex.customReplacementsRegex': {
    title: 'Custom pattern replacements',
    description: 'Custom regular-expression replacements.',
    category: 'latex',
    honoredBy: everyHost(REPLACEMENT_ENGINE_READER),
    surfaces: { settingsView: 'latex' },
  },
  'latex.customReplacements': {
    title: 'Custom literal replacements',
    description: 'Custom direct text replacements.',
    category: 'latex',
    honoredBy: everyHost(REPLACEMENT_ENGINE_READER),
    surfaces: { settingsView: 'latex' },
  },
  'latexdiff.tempFileLocation': {
    honoredBy: everyHost('src/tools/approval/latexPreview.ts'),
  },
  // Only the extension's git commands read the commit count, but the setup
  // assistant's `update_config` tool writes it from any host, so a CLI-written
  // value must not then be reported as unknown.
  'git.numberOfCommitsToShow': {
    honoredBy: everyHost('src/tools/setup/ConfigTools.ts'),
  },
  'agentReview.runOnCommit': {
    honoredBy: {
      vscode: {
        reader:
          'packages/extension/src/frontend/review/agentReviewCommitWatcher.ts',
      },
    },
  },
  'audio.soxPath': {
    honoredBy: everyHost('src/tools/media/audio.ts'),
  },
  'logger.debugMode': {
    honoredBy: everyHost('src/logger/logUtils.ts'),
  },
  'telemetry.enabled': {
    title: 'Usage telemetry',
    description:
      'Send model, token, cost, timing, route, and host metadata. TeXRA never sends prompt text, document content, or file names.',
    category: 'account',
    configTarget: 'global',
    honoredBy: everyHost('src/telemetry/UsageLogService.ts'),
    surfaces: { settingsView: 'telemetry' },
  },
  'debug.saveModelIO': {
    honoredBy: everyHost('src/agent/debug/debugMessageSaver.ts'),
  },
  'skills.enabled': {
    title: 'Agent skills',
    description:
      'Discover TeXRA and imported skills and expose them to tool-use agent prompts.',
    category: 'tools',
    honoredBy: everyHost('src/agent/prompt/userVars.ts', {
      command:
        'texra agents run <tool-use-agent> --instruction "answer a short question"',
      through:
        'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/runAgent.ts -> src/agent/runtime/executeAgent.ts -> src/agent/runtime/AgentLaunchContext.ts -> src/agent/prompt/userVars.ts',
    }),
    surfaces: { settingsView: 'agent-skills', cliConfig: true },
  },
  'toolUse.requireEditApproval': {
    title: 'Under Ask: require approval for file edits',
    description:
      'When approval policy is Ask, show a diff before an agent changes workspace files. Inert under Never and Auto-approve.',
    category: 'tools',
    honoredBy: everyHost('src/tools/approval/toolEditApproval.ts'),
    surfaces: { settingsView: 'approval' },
  },
  'toolUse.requireBashApproval': {
    title: 'Under Ask: require approval for shell commands',
    description:
      'When approval policy is Ask, pause before an agent runs a shell command. Inert under Never and Auto-approve.',
    category: 'tools',
    honoredBy: everyHost('src/tools/approval/bashApproval.ts'),
    surfaces: { settingsView: 'approval' },
  },
};

function coreSettingRow(path: CoreSettingPath): StateSettingEntry {
  const spec = CORE_SETTING_ROWS[path];
  const schema = coreLeafSchema(path);
  return {
    ...spec,
    key: `texra.${path}`,
    schema,
    description: spec.description ?? schemaDescription(schema),
    slots: sameSlot('config'),
  };
}

/**
 * Config-tree rows. Every `CORE_SETTING_PATHS` entry appears here (the record
 * above is exhaustive), plus `texra.approvalPolicy`, which is config-backed but
 * lives outside `CoreSettingsShape`.
 */
const CORE_SETTINGS: readonly StateSettingEntry[] = [
  ...CORE_SETTING_PATHS.map(coreSettingRow),
  surfacedSetting({
    key: TEXRA_APPROVAL_POLICY_CONFIG_KEY,
    schema: TexraApprovalPolicySchema.prefault(TEXRA_APPROVAL_POLICY_DEFAULT),
    title: 'Approval policy',
    description:
      'Deny, ask, or auto-approve Bash and tool edits for this workspace. Under Ask, the two toggles below control each kind independently.',
    category: 'tools',
    slots: sameSlot('config'),
    honoredBy: {
      vscode: { reader: 'src/shared/approvalPolicy.ts' },
      desktop: { reader: 'src/shared/approvalPolicy.ts' },
      cli: {
        reader: 'packages/cli/src/runtime/cliConfig.ts',
        reachability: {
          command:
            'texra agents run <tool-use-agent> --instruction "run a shell command"',
          through:
            'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> packages/cli/src/runtime/cliContext.ts -> packages/cli/src/runtime/cliConfig.ts -> src/agent/runtime/SessionHandle.ts -> src/tools/approval/bashApproval.ts',
        },
      },
    },
    enumLabels: ['Never', 'Ask', 'Auto-approve'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
];

// ============================================================================
// State-backed rows
// ============================================================================

const GIT_AUTHOR_READER = 'packages/cli/src/runtime/gitAuthor.ts';
const CODEX_CONFIG_READER = 'src/tools/codexConfig.ts';
const CLAUDE_AGENT_CONFIG_READER = 'src/tools/claudeAgentConfig.ts';
const WORKFLOW_COMPILE_READER =
  'src/agent/implementations/flows/reflection/output/compileCheck.ts';
const PROXY_CONFIG_READER =
  'src/agent/modelHandlers/support/ProxyConfigResolver.ts';
const PROVIDER_CONFIG_READER = 'src/utils/config/providerConfig.ts';

const GIT_AUTHOR_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "create a git commit"',
  through:
    'packages/cli/src/runtime/initPlatform.ts -> packages/cli/src/runtime/gitAuthor.ts -> src/utils/system/execUtils.ts',
} satisfies CliRuntimeReachability;
const GIT_WORKTREE_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "delegate a task to a subagent"',
  through:
    'packages/cli/src/runtime/initPlatform.ts -> packages/cli/src/runtime/gitAuthor.ts -> src/tools/delegation/DelegationTools.ts',
} satisfies CliRuntimeReachability;
const WORKFLOW_COMPILE_RUNTIME_REACHABILITY = {
  command:
    'texra run <workflow-agent> --input paper.tex --instruction "revise the paper"',
  through:
    'packages/cli/src/commands/workflow.ts -> src/agent/implementations/flows/reflection/output/compileCheck.ts',
} satisfies CliRuntimeReachability;
const WORKFLOW_REJECT_RUNTIME_REACHABILITY = {
  command:
    'texra run <workflow-agent> --input paper.tex --instruction "revise the paper"',
  through:
    'packages/cli/src/commands/workflow.ts -> src/agent/implementations/flows/reflection/runReflectionFlow.ts',
} satisfies CliRuntimeReachability;
const OPENAI_WEBSOCKET_RUNTIME_REACHABILITY = {
  command:
    'texra run <workflow-agent> --model <openai-model> --input paper.tex --instruction "summarize the paper"',
  through:
    'packages/cli/src/commands/workflow.ts -> src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
} satisfies CliRuntimeReachability;
const OPENROUTER_ROUTING_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --model <openrouter-routable-model> --instruction "answer a short question"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/ModelFactory.ts -> src/utils/config/providerConfig.ts',
} satisfies CliRuntimeReachability;
const KIMI_CODE_ROUTING_RUNTIME_REACHABILITY = {
  // Requires a Kimi Code API key (`texra chat` /key flow or KIMI_CODE_API_KEY).
  command:
    'texra agents run <tool-use-agent> --model kimi3 --instruction "answer a short question"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/ModelFactory.ts -> src/model/kimiCodeSubscriptionRouting.ts',
} satisfies CliRuntimeReachability;
const PROVIDER_REGION_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --model <dashscope/minimax/moonshot/glm-model> --instruction "answer a short question"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/ModelFactory.ts -> src/agent/modelHandlers/ModelHandler.ts -> src/agent/modelHandlers/support/ProxyConfigResolver.ts',
} satisfies CliRuntimeReachability;
const PROVIDER_ENDPOINT_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --model <provider-model> --instruction "answer a short question"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/ModelFactory.ts -> src/agent/modelHandlers/support/ProxyConfigResolver.ts',
} satisfies CliRuntimeReachability;
const CODEX_AGENT_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "launch a Codex subagent"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/tools/codex.ts -> src/tools/codexConfig.ts',
} satisfies CliRuntimeReachability;
const CLAUDE_AGENT_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "launch a Claude Code subagent"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/tools/claudeAgent.ts -> src/tools/claudeAgentConfig.ts',
} satisfies CliRuntimeReachability;
const TOOL_AVAILABILITY_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "use an external tool"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/agentToolResolution.ts -> src/tools/toolAvailability.ts',
} satisfies CliRuntimeReachability;
const TOOL_PATH_PROTECTION_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "read a file outside the working directory"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/tools/pathResolution.ts',
} satisfies CliRuntimeReachability;

/**
 * Git identity rows keep the one documented slot divergence in the catalog:
 * the extension and desktop store them in worktree-shared WorkspaceState while
 * the CLI reads them from `.texra/config.json`, which is where an existing
 * user's values already live.
 */
const GIT_AUTHOR_SLOTS: SettingSlots = {
  vscode: 'workspaceState',
  desktop: 'workspaceState',
  cli: 'config',
};

const GIT_AUTHOR_HONORED_BY: SettingHonoredBy = {
  vscode: { reader: 'packages/extension/src/frontend/git/gitAuthorSetup.ts' },
  desktop: { reader: 'packages/desktop/src/main/desktopSettingsIpc.ts' },
  cli: {
    reader: GIT_AUTHOR_READER,
    reachability: GIT_AUTHOR_RUNTIME_REACHABILITY,
  },
};

// Written by the extension/desktop Models tab and the CLI's `/config` panel
// through the same catalog write path.
const PROVIDER_ENDPOINT_SETTINGS = PROVIDER_ENDPOINT_STATE_ENTRIES.map(
  ({ endpointKey, displayName }) =>
    surfacedSetting({
      key: endpointKey,
      schema: z.string().prefault(''),
      title: `${displayName} endpoint`,
      description: `Custom base URL for ${displayName} API requests. Leave empty to use the default endpoint.`,
      category: 'model',
      slots: sameSlot('globalState'),
      honoredBy: everyHost(
        PROXY_CONFIG_READER,
        PROVIDER_ENDPOINT_RUNTIME_REACHABILITY,
      ),
      surfaces: { settingsView: 'profile', cliConfig: true },
    }),
);

/**
 * Per-provider streaming toggles. Reads stay in `providerConfig`'s
 * `getProviderStreaming`, whose default-when-unset is the *global* streaming
 * toggle — the static `.prefault(true)` here matches that global default.
 */
const PROVIDER_STREAMING_SETTINGS = PROVIDER_STATE_ENTRIES.flatMap(
  ({ streamingKey, displayName }) =>
    streamingKey
      ? [
          surfacedSetting({
            key: streamingKey,
            schema: z.boolean().prefault(true),
            title: `${displayName} streaming`,
            description: `Stream ${displayName} responses incrementally instead of waiting for the full completion.`,
            category: 'model',
            slots: sameSlot('globalState'),
            honoredBy: everyHost(PROVIDER_CONFIG_READER),
            surfaces: { settingsView: 'profile' },
          }),
        ]
      : [],
);

/**
 * Region/routing toggles resolved by `ProxyConfigResolver`, each also a Models
 * tab control for its provider. The rows differ only in key, default, and
 * copy, so the shared fields are written once.
 */
const PROVIDER_ROUTING_SETTINGS = (
  [
    [
      GlobalStateKey.MOONSHOT_USE_CHINA,
      'moonshot',
      true,
      {
        label: 'Kimi/Moonshot China region',
        description:
          'Use the China endpoint (api.moonshot.cn) instead of international (api.moonshot.ai). Enabled by default. Keys are platform-specific — get international keys at platform.moonshot.ai.',
        warning:
          'A platform.moonshot.cn key does not work with the international endpoint, and vice versa.',
        warningUrl: 'https://platform.moonshot.ai/console',
        warningUrlLabel: 'International console',
      },
    ],
    [
      GlobalStateKey.DASHSCOPE_USE_CHINA,
      'dashscope',
      false,
      {
        label: 'Qwen China region (Bailian)',
        description:
          'Use the China region endpoint (dashscope.aliyuncs.com) instead of international (dashscope-intl.aliyuncs.com). Display name switches to "Bailian".',
      },
    ],
    [
      GlobalStateKey.MINIMAX_USE_CHINA,
      'minimax',
      false,
      {
        label: 'MiniMax China region',
        description:
          'Use the China region endpoint (api.minimaxi.com) instead of international (api.minimax.io). API keys are region-specific — you must obtain a key from the matching region.',
        warning:
          'International keys do not work with the China endpoint, and vice versa. Coding Plan keys are also region-specific.',
        warningUrl: 'https://platform.minimax.io/',
        warningUrlLabel: 'Get API key',
      },
    ],
    [
      GlobalStateKey.GLM_USE_CHINA,
      'glm',
      true,
      {
        label: 'GLM China region',
        description:
          'Use the China region endpoint (open.bigmodel.cn) instead of international (api.z.ai). Enabled by default. API keys work with either endpoint.',
        warningUrl: 'https://open.bigmodel.cn/',
        warningUrlLabel: 'BigModel console',
      },
    ],
  ] as const
).map(([key, provider, defaultValue, copy]) =>
  surfacedSetting({
    key,
    schema: z.boolean().prefault(defaultValue),
    title: copy.label,
    description: copy.description,
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      PROXY_CONFIG_READER,
      PROVIDER_REGION_RUNTIME_REACHABILITY,
    ),
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [{ provider, ...copy }],
    },
  }),
);

export const STATE_SETTINGS: readonly StateSettingEntry[] = [
  // --- Git commit author marking ---------------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.GIT_MARK_COMMITS,
    schema: z.boolean().prefault(DEFAULT_GIT_MARK_COMMITS),
    title: 'Mark agent commits',
    description:
      'Attribute agent-authored git commits to the TeXRA identity so they are distinguishable from your own commits.',
    category: 'git',
    slots: GIT_AUTHOR_SLOTS,
    honoredBy: GIT_AUTHOR_HONORED_BY,
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.GIT_AUTHOR_NAME,
    schema: z.string().prefault(DEFAULT_GIT_AUTHOR_NAME),
    title: 'Agent commit author',
    description:
      'Author and committer name used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    slots: GIT_AUTHOR_SLOTS,
    honoredBy: GIT_AUTHOR_HONORED_BY,
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.GIT_AUTHOR_EMAIL,
    schema: z.string().prefault(DEFAULT_GIT_AUTHOR_EMAIL),
    title: 'Agent commit email',
    description:
      'Author and committer email used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    slots: GIT_AUTHOR_SLOTS,
    honoredBy: GIT_AUTHOR_HONORED_BY,
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
    schema: z.boolean().prefault(DEFAULT_GIT_WORKTREE_SUPPORT),
    title: 'Subagent worktrees',
    description:
      'Allow spawned subagents to run in isolated git worktrees so parallel edits do not conflict.',
    category: 'git',
    slots: GIT_AUTHOR_SLOTS,
    honoredBy: {
      ...GIT_AUTHOR_HONORED_BY,
      cli: {
        reader: GIT_AUTHOR_READER,
        reachability: GIT_WORKTREE_RUNTIME_REACHABILITY,
      },
    },
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),

  // --- Multi-agent coordination --------------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
    schema: z.boolean().prefault(true),
    title: 'Allow orchestrator cancellation',
    description:
      'Allow the orchestrator to stop subagents that are no longer needed.',
    category: 'multi-agent',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost('src/tools/ExecutionsTool.ts'),
    surfaces: { settingsView: 'multi-agent' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
    schema: z.boolean().prefault(false),
    title: 'Keep subagents running',
    description:
      'Let active subagents continue when the orchestrator is stopped.',
    category: 'multi-agent',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost('src/agent/runtime/detachSubagentsOnStop.ts'),
    surfaces: { settingsView: 'multi-agent' },
  }),

  // --- External coding agent controls ---------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.CODEX_SANDBOX_MODE,
    schema: CodexSandboxModeSchema.prefault(CODEX_SANDBOX_MODE_DEFAULT),
    title: 'Codex sandbox mode',
    description: 'Filesystem access mode used when TeXRA launches Codex.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(CODEX_CONFIG_READER, CODEX_AGENT_RUNTIME_REACHABILITY),
    enumLabels: ['Read-only', 'Workspace write', 'Full access'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.CODEX_REASONING_EFFORT,
    schema: CodexReasoningEffortSchema.prefault(CODEX_REASONING_EFFORT_DEFAULT),
    title: 'Codex reasoning effort',
    description: 'Reasoning effort hint passed to Codex runs.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(CODEX_CONFIG_READER, CODEX_AGENT_RUNTIME_REACHABILITY),
    enumLabels: ['Low', 'Medium', 'High', 'Extra high'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.CODEX_APPROVAL_POLICY,
    schema: CodexApprovalPolicySchema.prefault(CODEX_APPROVAL_POLICY_DEFAULT),
    title: 'Codex approval policy',
    description: 'When Codex should ask for approval before risky actions.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(CODEX_CONFIG_READER, CODEX_AGENT_RUNTIME_REACHABILITY),
    enumLabels: [
      'Auto approve',
      'Ask when requested',
      'Ask for untrusted',
      'Ask on failure',
    ],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_MODEL,
    schema: ClaudeAgentModelSchema.prefault(CLAUDE_AGENT_DEFAULT_MODEL),
    normalizePersisted: parseClaudeAgentModel,
    title: 'Claude Code model',
    description: 'Claude model selected for Claude Code agent sessions.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      CLAUDE_AGENT_CONFIG_READER,
      CLAUDE_AGENT_RUNTIME_REACHABILITY,
    ),
    enumLabels: ['Sonnet 5', 'Fable 5', 'Opus 5', 'Haiku 4.5'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
    schema: ClaudeAgentPermissionModeSchema.prefault(
      CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
    ),
    title: 'Claude Code permission mode',
    description: 'Permission policy used by Claude Code agent sessions.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      CLAUDE_AGENT_CONFIG_READER,
      CLAUDE_AGENT_RUNTIME_REACHABILITY,
    ),
    enumLabels: [
      'Prompt for risky actions',
      'Auto-accept edits',
      'Bypass all (dangerous)',
      'Plan only (read-only)',
    ],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
    schema: ClaudeAgentEffortSchema.prefault(CLAUDE_AGENT_DEFAULT_EFFORT),
    title: 'Claude Code reasoning effort',
    description: 'Reasoning effort hint passed to Claude Code agent sessions.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      CLAUDE_AGENT_CONFIG_READER,
      CLAUDE_AGENT_RUNTIME_REACHABILITY,
    ),
    enumLabels: ['Low', 'Medium', 'High', 'Extra high', 'Maximum'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),

  // --- Workflow auto-compile -------------------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompile),
    title: 'Auto-compile outputs',
    description:
      'Compile the LaTeX project automatically after an agent writes its output.',
    category: 'workflow',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      WORKFLOW_COMPILE_READER,
      WORKFLOW_COMPILE_RUNTIME_REACHABILITY,
    ),
    surfaces: { settingsView: 'latex', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
    schema: z
      .int()
      .min(LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min)
      .prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs),
    title: 'Auto-compile timeout',
    description:
      'Maximum time (in milliseconds) to wait for an automatic post-output compile before giving up.',
    category: 'workflow',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      WORKFLOW_COMPILE_READER,
      WORKFLOW_COMPILE_RUNTIME_REACHABILITY,
    ),
    surfaces: { settingsView: 'latex', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoOpenPdf),
    description:
      'Open the compiled PDF automatically after a successful auto-compile.',
    category: 'workflow',
    slots: sameSlot('workspaceState'),
    // Read by the reflection flow, but the emitted `requestOpenFile` has no CLI
    // handler (headless), so the CLI does not honor it.
    honoredBy: webviewHosts(
      'src/agent/implementations/flows/reflection/runReflectionFlow.ts',
    ),
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
    schema: z
      .boolean()
      .prefault(LATEX_CONFIG_DEFAULTS.workflowRejectOnCompileFailure),
    title: 'Reject compile failures',
    description:
      'Reject an agent edit when the automatic post-output compile fails, so broken LaTeX is not accepted.',
    category: 'workflow',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      'src/agent/implementations/flows/reflection/runReflectionFlow.ts',
      WORKFLOW_REJECT_RUNTIME_REACHABILITY,
    ),
    surfaces: { settingsView: 'latex', cliConfig: true },
  }),

  // --- LaTeXdiff -------------------------------------------------------------
  // Run by the reflection flow, so every host honors them; deferred from the
  // CLI `/config` panel by product decision, which is a surface choice only.
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds),
    description:
      'Generate a latexdiff between successive reflection rounds, not just against the original input.',
    category: 'latexdiff',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      'src/agent/implementations/flows/reflection/output/LatexDiffManager.ts',
    ),
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
    schema: z
      .int()
      .min(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.min)
      .max(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.max)
      .prefault(LATEX_CONFIG_DEFAULTS.latexdiffTimeoutMs),
    description:
      'Maximum time (in milliseconds) to allow a single latexdiff invocation to run.',
    category: 'latexdiff',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost('src/latex/latexdiff.ts'),
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
    schema: z
      .enum(LATEXDIFF_MATH_MARKUP_VALUES)
      .prefault(LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup),
    description: 'How latexdiff marks up changes inside math environments.',
    category: 'latexdiff',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost('src/latex/latexdiff/diffCommandExecutor.ts'),
    enumDescriptions: [
      'suppress markup',
      'equation-level',
      'within equations',
      'small changes inside equations',
    ],
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly),
    description:
      'Produce a changes-only diff (show only the parts that changed) rather than the full marked-up document.',
    category: 'latexdiff',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost('src/latex/latexdiff/diffCommandExecutor.ts'),
    surfaces: { settingsView: 'latex' },
  }),

  // --- LaTeX formatter -------------------------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.LATEX_FORMATTER,
    schema: z
      .enum(LATEX_FORMATTER_VALUES)
      .prefault(LATEX_CONFIG_DEFAULTS.latexFormatter),
    description: 'Which formatter to run when formatting LaTeX source.',
    category: 'latex',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost('src/latex/formatter/texFormatter.ts'),
    enumDescriptions: [
      'Format with latexindent.',
      'Format with tex-fmt.',
      'Do not run any formatter.',
    ],
    surfaces: { settingsView: 'latex' },
  }),

  // --- OpenAI WebSocket transport (experimental) -----------------------------
  surfacedSetting({
    key: GlobalStateKey.WEBSOCKET_OPENAI,
    schema: z.boolean().prefault(false),
    title: 'OpenAI WebSocket',
    description:
      'EXPERIMENTAL: use the persistent WebSocket transport for OpenAI Responses requests (lower latency for tool-use loops), and let the ChatGPT-subscription Codex backend attempt WebSocket. Off by default.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
      OPENAI_WEBSOCKET_RUNTIME_REACHABILITY,
    ),
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [
        {
          provider: 'openai',
          label: 'WebSocket transport',
          description:
            'Use a persistent WebSocket connection for lower-latency tool-use loops. Requires direct OpenAI API (not compatible with custom endpoints).',
        },
      ],
    },
  }),

  // --- Provider endpoints & streaming ---------------------------------------
  ...PROVIDER_ENDPOINT_SETTINGS,
  ...PROVIDER_STREAMING_SETTINGS,
  surfacedSetting({
    key: GlobalStateKey.STREAMING_GLOBAL,
    schema: z.boolean().prefault(true),
    title: 'Enable streaming',
    description: 'Global default for all providers.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(PROVIDER_CONFIG_READER),
    surfaces: { settingsView: 'profile' },
  }),

  // --- Model picker preferences ---------------------------------------------
  surfacedSetting({
    key: GlobalStateKey.HELPER_MODEL,
    schema: z.string().min(1).prefault(DEFAULT_HELPER_MODEL),
    title: 'Helper model',
    description:
      'Model used for auxiliary tasks: instruction polishing, merges, and session descriptions.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost('src/agent/runtime/helperModelName.ts'),
    surfaces: { settingsView: 'models' },
  }),
  surfacedSetting({
    key: GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
    schema: z.boolean().prefault(false),
    title: 'Prefer short model names',
    description: 'Show compact model names in pickers.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost('src/agent/runtime/ModelFactory.ts'),
    surfaces: { settingsView: 'models' },
  }),

  // --- OpenRouter routing ----------------------------------------------------
  surfacedSetting({
    key: GlobalStateKey.USE_OPENROUTER,
    schema: z.boolean().prefault(false),
    title: 'Use OpenRouter for all models',
    description: `Route all API calls through OpenRouter instead of direct provider APIs. Requires an OpenRouter API key. OpenRouter does not use ${INCLUDED_ACCESS.inline}: your OpenRouter key is always used directly.`,
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      PROVIDER_CONFIG_READER,
      OPENROUTER_ROUTING_RUNTIME_REACHABILITY,
    ),
    onWrite: { invalidatesModelOptions: true },
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [
        {
          provider: 'openRouter',
          label: 'Use OpenRouter for all models',
          description: `Route all API calls through OpenRouter instead of direct provider APIs. Requires an OpenRouter API key. OpenRouter does not use ${INCLUDED_ACCESS.inline}: your OpenRouter key is always used directly.`,
        },
      ],
    },
  }),

  // --- Provider routing & region toggles --------------------------------------
  surfacedSetting({
    key: GlobalStateKey.KIMI_CODE_PREFER,
    schema: z.boolean().prefault(false),
    title: 'Prefer Kimi Code',
    description:
      'Route dual-backend Kimi models (K3) through the Kimi Code coding endpoint when a Kimi Code API key is set. The two coding-only models always use the key. When off, K3 uses the Moonshot open platform.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      'src/agent/runtime/ModelFactory.ts',
      KIMI_CODE_ROUTING_RUNTIME_REACHABILITY,
    ),
    // Kimi Code and OpenRouter are alternative routes for the same dual-backend
    // models, so enabling one clears the other on every write path.
    onWrite: {
      disablesWhenEnabled: [GlobalStateKey.USE_OPENROUTER],
      invalidatesModelOptions: true,
    },
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [
        {
          provider: 'kimiCode',
          label: 'Prefer Kimi Code',
          description:
            'Route dual-backend Kimi models (K3) through the Kimi Code coding endpoint when a Kimi Code API key is set. The two coding-only models always use the key. When off, K3 uses the Moonshot open platform.',
        },
      ],
    },
  }),
  ...PROVIDER_ROUTING_SETTINGS,
  surfacedSetting({
    key: GlobalStateKey.GLM_CODING_PLAN,
    schema: z.boolean().prefault(false),
    title: 'GLM Coding Plan',
    description:
      'Use a Coding Plan subscription key instead of pay-as-you-go. Routes requests through the coding-specific endpoint with monthly quota limits.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      PROXY_CONFIG_READER,
      PROVIDER_REGION_RUNTIME_REACHABILITY,
    ),
    onWrite: { invalidatesModelOptions: true },
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [
        {
          provider: 'glm',
          label: 'GLM Coding Plan',
          description:
            'Use a Coding Plan subscription key instead of pay-as-you-go. Routes requests through the coding-specific endpoint with monthly quota limits.',
          warningUrl: 'https://z.ai/subscribe',
          warningUrlLabel: 'Subscribe',
        },
      ],
    },
  }),

  // --- External tool integrations ------------------------------------------
  // This is a list-backed global-state domain. `/config` delegates editing to
  // the existing `/tools` form so the catalog owns discoverability while the
  // tool dashboard remains the single editor for per-integration toggles.
  surfacedSetting({
    key: GlobalStateKey.DISABLED_TOOLS,
    schema: z.array(z.string()).prefault([]),
    title: 'Tool integrations',
    description:
      'Enable or disable external tool integration groups used by agent tool resolution.',
    category: 'tools',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      'src/tools/toolAvailability.ts',
      TOOL_AVAILABILITY_RUNTIME_REACHABILITY,
    ),
    openForm: 'tools',
    surfaces: { cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
    schema: z.boolean().prefault(DEFAULT_TOOL_PATH_PROTECTION_ENABLED),
    title: 'Restrict tool paths',
    description:
      'Keep file-reading, editing, search, diagnostics, and PDF tools inside the active working directory. Turn this off only when an agent must use arbitrary filesystem paths.',
    category: 'tools',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      'src/tools/pathResolution.ts',
      TOOL_PATH_PROTECTION_RUNTIME_REACHABILITY,
    ),
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
];

// ============================================================================
// Derived views — every list below is a filter, never hand-maintained
// ============================================================================

/** Every catalog row, config-tree and state-backed. */
export const ALL_SETTINGS: readonly StateSettingEntry[] = [
  ...CORE_SETTINGS,
  ...STATE_SETTINGS,
];

const STATE_SETTINGS_BY_KEY: ReadonlyMap<string, StateSettingEntry> = new Map(
  STATE_SETTINGS.map((entry) => [entry.key, entry]),
);

const SETTINGS_BY_KEY: ReadonlyMap<string, StateSettingEntry> = new Map(
  ALL_SETTINGS.map((entry) => [entry.key, entry]),
);

function isSurfaced(entry: StateSettingEntry): entry is SurfacedSettingEntry {
  return (
    entry.surfaces !== undefined &&
    entry.description !== undefined &&
    entry.category !== undefined
  );
}

const SURFACED_SETTINGS: readonly SurfacedSettingEntry[] =
  ALL_SETTINGS.filter(isSurfaced);

const SETTINGS_VIEW_SETTINGS_BY_KEY: ReadonlyMap<
  string,
  SettingsViewStateSettingEntry
> = new Map(
  SURFACED_SETTINGS.filter(
    (entry): entry is SettingsViewStateSettingEntry =>
      entry.surfaces.settingsView !== undefined,
  ).map((entry) => [entry.key, entry]),
);

/** Look up a state-backed catalog entry by its canonical `texra.*` key. */
export function stateSettingByKey(key: string): StateSettingEntry | undefined {
  return STATE_SETTINGS_BY_KEY.get(key);
}

/** Look up any catalog entry — config-tree or state-backed — by its key. */
export function settingByKey(key: string): StateSettingEntry | undefined {
  return SETTINGS_BY_KEY.get(key);
}

/** Look up a scalar setting owned by the settings view's unified write path. */
export function settingsViewSettingByKey(
  key: string,
): SettingsViewStateSettingEntry | undefined {
  return SETTINGS_VIEW_SETTINGS_BY_KEY.get(key);
}

/**
 * The `/config` roster: every row the CLI panel renders, across both catalog
 * tiers. `surfaces.cliConfig` is the single predicate, so a row can be honored
 * by the CLI runtime without being editable there (and the guardrail suite
 * still demands runtime-reachability evidence for the ones that are).
 */
export const CLI_STATE_SETTINGS: readonly SurfacedSettingEntry[] =
  SURFACED_SETTINGS.filter((entry) => entry.surfaces.cliConfig === true);

/**
 * Canonical `texra.*` keys the CLI reads from `.texra/config.json` — the
 * unknown-key whitelist's catalog half. Derived from the two facts that decide
 * it: the CLI's runtime honors the row, and the CLI's slot for it is `config`.
 */
export const CLI_CONFIG_SLOT_KEYS: readonly string[] = ALL_SETTINGS.filter(
  (entry) => entry.honoredBy.cli !== undefined && entry.slots.cli === 'config',
).map((entry) => entry.key);

/** Models tab controls for one provider, in catalog order. */
export function modelsTabSettings(provider: string): readonly {
  readonly entry: StateSettingEntry;
  readonly surface: ModelsTabSurface;
}[] {
  return ALL_SETTINGS.flatMap((entry) =>
    (entry.surfaces?.models ?? [])
      .filter((surface) => surface.provider === provider)
      .map((surface) => ({ entry, surface })),
  );
}

/** The entry's schema with the outer `.prefault()` wrapper peeled off. */
function innerSchema(entry: StateSettingEntry): unknown {
  return entry.schema instanceof z.ZodPrefault
    ? entry.schema.unwrap()
    : entry.schema;
}

/**
 * Enum option values for a setting, derived from its `z.enum(...)` schema (via
 * the public `.unwrap().options`) rather than restated on the row, or
 * `undefined` for non-enum settings. The schema stays the single source of the
 * allowed values; only the per-value prose (`enumDescriptions`) is editorial.
 */
export function settingEnumOptions(
  entry: StateSettingEntry,
): readonly string[] | undefined {
  const inner = innerSchema(entry);
  return inner instanceof z.ZodEnum
    ? (inner.options as readonly string[])
    : undefined;
}

export interface SettingEnumChoice<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
}

/** Enum values paired with display metadata for settings UIs. */
export function settingEnumChoices<T extends string = string>(
  entry: StateSettingEntry,
): readonly SettingEnumChoice<T>[] | undefined {
  const values = settingEnumOptions(entry);
  if (!values) return undefined;
  return values.map((value, index) => ({
    value: value as T,
    label: entry.enumLabels?.[index] ?? value,
    ...(entry.enumDescriptions?.[index] && {
      description: entry.enumDescriptions[index],
    }),
  }));
}

/** Whether a setting's schema is a boolean (used to classify edit affordance). */
export function settingIsBoolean(entry: StateSettingEntry): boolean {
  return innerSchema(entry) instanceof z.ZodBoolean;
}

/** Whether a setting's schema is a string (free-text edit affordance). */
export function settingIsString(entry: StateSettingEntry): boolean {
  return innerSchema(entry) instanceof z.ZodString;
}

/** Whether a setting's schema is a number (numeric free-text edit affordance). */
export function settingIsNumber(entry: StateSettingEntry): boolean {
  return innerSchema(entry) instanceof z.ZodNumber;
}
