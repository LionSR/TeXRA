// Third-party imports
import { z } from 'zod';

// Local imports - shared constants & state keys
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_DEFAULT,
  TexraApprovalPolicySchema,
} from '@shared/approvalPolicy';
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
  LATEX_FORMATTER_VALUES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latexConfig';
import {
  DASHSCOPE_USE_CHINA_PROVIDER_SETTING,
  GLM_CODING_PLAN_PROVIDER_SETTING,
  GLM_USE_CHINA_PROVIDER_SETTING,
  KIMI_CODE_PREFER_PROVIDER_SETTING,
  MINIMAX_USE_CHINA_PROVIDER_SETTING,
  MOONSHOT_USE_CHINA_PROVIDER_SETTING,
  PROVIDER_ENDPOINT_STATE_ENTRIES,
  USE_OPENROUTER_PROVIDER_SETTING,
} from '@shared/constants/providers';
import {
  BASH_APPROVAL_CONFIG_KEY,
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
import { AGENT_SKILLS_CONFIG_KEY } from '@shared/schemas/agentSkills';
import {
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  CoreSettingsShape,
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
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

/**
 * Host-neutral catalog for **state-backed** TeXRA settings.
 *
 * Unlike {@link CoreSettingsShape}, which is stored in TeXRA's shared JSON
 * configuration, these keys are read from WorkspaceState / GlobalState. They
 * live here as metadata rows because their persistence scope and host
 * reachability differ from ordinary configuration.
 *
 * Each row is the single source of truth for a state-backed setting's default,
 * validation schema, description, storage slot, and the hosts that consume it.
 * Consumers:
 *
 * - `settingsAccess.ts` — host-aware read/write that dispatches on `store`
 *   (or `cliStore` when the caller is the CLI).
 * - `packages/cli/src/schemas/knownKeys.ts` — derives the CLI unknown-key
 *   whitelist from {@link STATE_SETTING_KEYS}.
 * - The CLI `/config` panel + extension settingsView (later PRs) read labels,
 *   descriptions, and enum metadata from these rows.
 */

/** Hosts that may consume a setting. */
type SettingHost = 'vscode' | 'cli' | 'desktop';

/** Storage slot a setting is read from / written to. */
export type SettingStore = 'config' | 'workspaceState' | 'globalState';
export type SettingsViewSnapshot =
  | 'agent-skills'
  | 'approval'
  | 'git-author'
  | 'latex'
  | 'multi-agent'
  | 'telemetry';

interface CliRuntimeReachability {
  /**
   * Representative CLI command that reaches this setting after it has been set.
   * Placeholders are allowed when the command needs an installed agent/model.
   */
  readonly command: string;
  /**
   * Short manual trace from the CLI command surface to {@link cliConsumer}. This
   * is a review checklist item, not executable wiring.
   */
  readonly through: string;
}

export interface StateSettingEntry {
  /**
   * Canonical `texra.*` key — identical to the WorkspaceState/GlobalState slot
   * the extension already uses.
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
  readonly description: string;
  /** Grouping label for settings UIs. */
  readonly category: string;
  /** Canonical (extension) storage slot. */
  readonly store: SettingStore;
  /** Persistence target for config-backed settings; workspace when omitted. */
  readonly configTarget?: 'global' | 'workspace';
  /**
   * Storage slot the CLI reads/writes when it differs from {@link store}. Only
   * the git-author keys use this today: the extension keeps them in
   * worktree-shared WorkspaceState, but the CLI reads them from
   * `.texra/config.json`.
   */
  readonly cliStore?: SettingStore;
  /** Hosts that actually consume this setting today. */
  readonly hosts: readonly SettingHost[];
  /**
   * Source file that consumes the setting in the CLI. **Required** whenever
   * {@link hosts} includes `'cli'` (enforced by the guardrail suite) so a
   * surfaced setting is never a silent no-op.
   */
  readonly cliConsumer?: string;
  /**
   * Runtime-reachability evidence for CLI-hosted settings. **Required** whenever
   * {@link hosts} includes `'cli'` (enforced by the guardrail suite), so marking
   * a setting as CLI-consumed requires more than naming an existing file.
   */
  readonly cliRuntimeReachability?: CliRuntimeReachability;
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
  /** Settings-view snapshot to rebroadcast after this row is written. */
  readonly settingsViewSnapshot?: SettingsViewSnapshot;
}

export type SettingsViewStateSettingEntry = StateSettingEntry & {
  readonly settingsViewSnapshot: SettingsViewSnapshot;
};

/**
 * Builds one catalog row, requiring `cliConsumer` and `cliRuntimeReachability`
 * at the call site whenever `hosts` includes `'cli'` — previously that
 * pairing was enforced only by a runtime guardrail test
 * (`stateSettings.vitest.ts`), so a row could omit them and fail nothing
 * until the suite ran. `const H` infers the literal host tuple straight from
 * the call site, no `as const` needed per row. The guardrail test still owns
 * what a type can't check: that `cliConsumer` names a file that exists and
 * that `cliRuntimeReachability.through` actually names it.
 */
function stateSetting<const H extends readonly SettingHost[]>(
  entry: Omit<
    StateSettingEntry,
    'hosts' | 'cliConsumer' | 'cliRuntimeReachability'
  > & { readonly hosts: H } & ('cli' extends H[number]
      ? {
          readonly cliConsumer: string;
          readonly cliRuntimeReachability: CliRuntimeReachability;
        }
      : {
          readonly cliConsumer?: undefined;
          readonly cliRuntimeReachability?: undefined;
        }),
): StateSettingEntry {
  return entry;
}

const GIT_AUTHOR_CONSUMER = 'packages/cli/src/runtime/gitAuthor.ts';
const CODEX_CONFIG_CONSUMER = 'src/tools/codexConfig.ts';
const CLAUDE_AGENT_CONFIG_CONSUMER = 'src/tools/claudeAgentConfig.ts';
const WORKFLOW_COMPILE_CONSUMER =
  'src/agent/implementations/flows/reflection/output/compileCheck.ts';
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
const AGENT_SKILLS_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "answer a short question"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/runAgent.ts -> src/agent/runtime/executeAgent.ts -> src/agent/runtime/AgentLaunchContext.ts -> src/agent/prompt/userVars.ts',
} satisfies CliRuntimeReachability;
const TEXRA_APPROVAL_POLICY_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "run a shell command"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> packages/cli/src/runtime/cliContext.ts -> packages/cli/src/runtime/cliConfig.ts -> src/agent/runtime/SessionHandle.ts -> src/tools/approval/bashApproval.ts',
} satisfies CliRuntimeReachability;

const PROXY_CONFIG_CONSUMER =
  'src/agent/modelHandlers/support/ProxyConfigResolver.ts';

const PROVIDER_ENDPOINT_SETTINGS = PROVIDER_ENDPOINT_STATE_ENTRIES.map(
  ({ endpointKey, displayName }) =>
    stateSetting({
      key: endpointKey,
      schema: z.string().prefault(''),
      title: `${displayName} endpoint`,
      description: `Custom base URL for ${displayName} API requests. Leave empty to use the default endpoint.`,
      category: 'model',
      store: 'globalState',
      hosts: ['cli'],
      cliConsumer: PROXY_CONFIG_CONSUMER,
      cliRuntimeReachability: PROVIDER_ENDPOINT_RUNTIME_REACHABILITY,
    }),
);

/**
 * Region/routing toggles resolved by `ProxyConfigResolver`. Same idiom as
 * {@link PROVIDER_ENDPOINT_SETTINGS}: the rows differ only in key, default, and
 * the provider-setting const supplying label/description, so the shared fields
 * are written once. See the catalog comment at the spread site.
 */
const PROVIDER_ROUTING_SETTINGS = (
  [
    [
      GlobalStateKey.MOONSHOT_USE_CHINA,
      MOONSHOT_USE_CHINA_PROVIDER_SETTING,
      true,
    ],
    [
      GlobalStateKey.DASHSCOPE_USE_CHINA,
      DASHSCOPE_USE_CHINA_PROVIDER_SETTING,
      false,
    ],
    [
      GlobalStateKey.MINIMAX_USE_CHINA,
      MINIMAX_USE_CHINA_PROVIDER_SETTING,
      false,
    ],
    [GlobalStateKey.GLM_USE_CHINA, GLM_USE_CHINA_PROVIDER_SETTING, true],
    [GlobalStateKey.GLM_CODING_PLAN, GLM_CODING_PLAN_PROVIDER_SETTING, false],
  ] as const
).map(([key, setting, defaultValue]) =>
  stateSetting({
    key,
    schema: z.boolean().prefault(defaultValue),
    title: setting.label,
    description: setting.description,
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: PROXY_CONFIG_CONSUMER,
    cliRuntimeReachability: PROVIDER_REGION_RUNTIME_REACHABILITY,
  }),
);

export const STATE_SETTINGS: readonly StateSettingEntry[] = [
  // --- Git commit author marking ---------------------------------------------
  // Stored in worktree-shared WorkspaceState by the extension; read from
  // `.texra/config.json` by the CLI (hence `cliStore: 'config'`).
  stateSetting({
    key: WorkspaceStateKey.GIT_MARK_COMMITS,
    schema: z.boolean().prefault(DEFAULT_GIT_MARK_COMMITS),
    title: 'Mark agent commits',
    description:
      'Attribute agent-authored git commits to the TeXRA identity so they are distinguishable from your own commits.',
    category: 'git',
    store: 'workspaceState',
    cliStore: 'config',
    hosts: ['vscode', 'cli', 'desktop'],
    cliConsumer: GIT_AUTHOR_CONSUMER,
    cliRuntimeReachability: GIT_AUTHOR_RUNTIME_REACHABILITY,
    settingsViewSnapshot: 'git-author',
  }),
  stateSetting({
    key: WorkspaceStateKey.GIT_AUTHOR_NAME,
    schema: z.string().prefault(DEFAULT_GIT_AUTHOR_NAME),
    title: 'Agent commit author',
    description:
      'Author and committer name used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    store: 'workspaceState',
    cliStore: 'config',
    hosts: ['vscode', 'cli', 'desktop'],
    cliConsumer: GIT_AUTHOR_CONSUMER,
    cliRuntimeReachability: GIT_AUTHOR_RUNTIME_REACHABILITY,
    settingsViewSnapshot: 'git-author',
  }),
  stateSetting({
    key: WorkspaceStateKey.GIT_AUTHOR_EMAIL,
    schema: z.string().prefault(DEFAULT_GIT_AUTHOR_EMAIL),
    title: 'Agent commit email',
    description:
      'Author and committer email used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    store: 'workspaceState',
    cliStore: 'config',
    hosts: ['vscode', 'cli', 'desktop'],
    cliConsumer: GIT_AUTHOR_CONSUMER,
    cliRuntimeReachability: GIT_AUTHOR_RUNTIME_REACHABILITY,
    settingsViewSnapshot: 'git-author',
  }),
  stateSetting({
    key: WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
    schema: z.boolean().prefault(DEFAULT_GIT_WORKTREE_SUPPORT),
    title: 'Subagent worktrees',
    description:
      'Allow spawned subagents to run in isolated git worktrees so parallel edits do not conflict.',
    category: 'git',
    store: 'workspaceState',
    cliStore: 'config',
    hosts: ['vscode', 'cli', 'desktop'],
    cliConsumer: GIT_AUTHOR_CONSUMER,
    cliRuntimeReachability: GIT_WORKTREE_RUNTIME_REACHABILITY,
    settingsViewSnapshot: 'git-author',
  }),

  // --- Multi-agent coordination --------------------------------------------
  stateSetting({
    key: WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
    schema: z.boolean().prefault(true),
    title: 'Allow orchestrator cancellation',
    description:
      'Allow the orchestrator to stop subagents that are no longer needed.',
    category: 'multi-agent',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'multi-agent',
  }),
  stateSetting({
    key: WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
    schema: z.boolean().prefault(false),
    title: 'Keep subagents running',
    description:
      'Let active subagents continue when the orchestrator is stopped.',
    category: 'multi-agent',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'multi-agent',
  }),

  // --- External coding agent controls ---------------------------------------
  // These are workspace-shared settings read by the Codex and Claude Code tool
  // integrations. The CLI reaches them through headless tool-use runs, so the
  // same catalog drives both the extension/desktop settings view and `/config`.
  stateSetting({
    key: WorkspaceStateKey.CODEX_SANDBOX_MODE,
    schema: CodexSandboxModeSchema.prefault(CODEX_SANDBOX_MODE_DEFAULT),
    title: 'Codex sandbox mode',
    description: 'Filesystem access mode used when TeXRA launches Codex.',
    category: 'ai-agents',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: CODEX_CONFIG_CONSUMER,
    cliRuntimeReachability: CODEX_AGENT_RUNTIME_REACHABILITY,
    enumLabels: ['Read-only', 'Workspace write', 'Full access'],
    settingsViewSnapshot: 'approval',
  }),
  stateSetting({
    key: WorkspaceStateKey.CODEX_REASONING_EFFORT,
    schema: CodexReasoningEffortSchema.prefault(CODEX_REASONING_EFFORT_DEFAULT),
    title: 'Codex reasoning effort',
    description: 'Reasoning effort hint passed to Codex runs.',
    category: 'ai-agents',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: CODEX_CONFIG_CONSUMER,
    cliRuntimeReachability: CODEX_AGENT_RUNTIME_REACHABILITY,
    enumLabels: ['Low', 'Medium', 'High', 'Extra high'],
    settingsViewSnapshot: 'approval',
  }),
  stateSetting({
    key: WorkspaceStateKey.CODEX_APPROVAL_POLICY,
    schema: CodexApprovalPolicySchema.prefault(CODEX_APPROVAL_POLICY_DEFAULT),
    title: 'Codex approval policy',
    description: 'When Codex should ask for approval before risky actions.',
    category: 'ai-agents',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: CODEX_CONFIG_CONSUMER,
    cliRuntimeReachability: CODEX_AGENT_RUNTIME_REACHABILITY,
    enumLabels: [
      'Auto approve',
      'Ask when requested',
      'Ask for untrusted',
      'Ask on failure',
    ],
    settingsViewSnapshot: 'approval',
  }),
  stateSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_MODEL,
    schema: ClaudeAgentModelSchema.prefault(CLAUDE_AGENT_DEFAULT_MODEL),
    normalizePersisted: parseClaudeAgentModel,
    title: 'Claude Code model',
    description: 'Claude model selected for Claude Code agent sessions.',
    category: 'ai-agents',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: CLAUDE_AGENT_CONFIG_CONSUMER,
    cliRuntimeReachability: CLAUDE_AGENT_RUNTIME_REACHABILITY,
    enumLabels: ['Sonnet 5', 'Fable 5', 'Opus 5', 'Haiku 4.5'],
    settingsViewSnapshot: 'approval',
  }),
  stateSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
    schema: ClaudeAgentPermissionModeSchema.prefault(
      CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
    ),
    title: 'Claude Code permission mode',
    description: 'Permission policy used by Claude Code agent sessions.',
    category: 'ai-agents',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: CLAUDE_AGENT_CONFIG_CONSUMER,
    cliRuntimeReachability: CLAUDE_AGENT_RUNTIME_REACHABILITY,
    enumLabels: [
      'Prompt for risky actions',
      'Auto-accept edits',
      'Bypass all (dangerous)',
      'Plan only (read-only)',
    ],
    settingsViewSnapshot: 'approval',
  }),
  stateSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
    schema: ClaudeAgentEffortSchema.prefault(CLAUDE_AGENT_DEFAULT_EFFORT),
    title: 'Claude Code reasoning effort',
    description: 'Reasoning effort hint passed to Claude Code agent sessions.',
    category: 'ai-agents',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: CLAUDE_AGENT_CONFIG_CONSUMER,
    cliRuntimeReachability: CLAUDE_AGENT_RUNTIME_REACHABILITY,
    enumLabels: ['Low', 'Medium', 'High', 'Extra high', 'Maximum'],
    settingsViewSnapshot: 'approval',
  }),

  // --- Workflow auto-compile -------------------------------------------------
  // The CLI runs workflow (reflection) agents via `texra workflow` / `texra
  // run`, so these take effect there as well as in the extension/desktop. The
  // exception is auto-open-pdf: it emits `requestOpenFile`, which the headless
  // CLI has no handler for, so it stays off the CLI roster.
  stateSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompile),
    title: 'Auto-compile outputs',
    description:
      'Compile the LaTeX project automatically after an agent writes its output.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: WORKFLOW_COMPILE_CONSUMER,
    cliRuntimeReachability: WORKFLOW_COMPILE_RUNTIME_REACHABILITY,
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
    schema: z
      .int()
      .min(LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min)
      .prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs),
    title: 'Auto-compile timeout',
    description:
      'Maximum time (in milliseconds) to wait for an automatic post-output compile before giving up.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: WORKFLOW_COMPILE_CONSUMER,
    cliRuntimeReachability: WORKFLOW_COMPILE_RUNTIME_REACHABILITY,
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoOpenPdf),
    description:
      'Open the compiled PDF automatically after a successful auto-compile.',
    category: 'workflow',
    store: 'workspaceState',
    // Read by OutputNode but the emitted `requestOpenFile` has no CLI handler
    // (headless), so toggling it would be a no-op there — vscode/desktop only.
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
    schema: z
      .boolean()
      .prefault(LATEX_CONFIG_DEFAULTS.workflowRejectOnCompileFailure),
    title: 'Reject compile failures',
    description:
      'Reject an agent edit when the automatic post-output compile fails, so broken LaTeX is not accepted.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer:
      'src/agent/implementations/flows/reflection/runReflectionFlow.ts',
    cliRuntimeReachability: WORKFLOW_REJECT_RUNTIME_REACHABILITY,
    settingsViewSnapshot: 'latex',
  }),

  // --- LaTeXdiff -------------------------------------------------------------
  // Run by the reflection flow (so the CLI executes them), but deferred from the
  // CLI roster for now per product decision — not surfaced in `/config`.
  stateSetting({
    key: WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds),
    description:
      'Generate a latexdiff between successive reflection rounds, not just against the original input.',
    category: 'latexdiff',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
    schema: z
      .int()
      .min(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.min)
      .max(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.max)
      .prefault(LATEX_CONFIG_DEFAULTS.latexdiffTimeoutMs),
    description:
      'Maximum time (in milliseconds) to allow a single latexdiff invocation to run.',
    category: 'latexdiff',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
    schema: z
      .enum(LATEXDIFF_MATH_MARKUP_VALUES)
      .prefault(LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup),
    description: 'How latexdiff marks up changes inside math environments.',
    category: 'latexdiff',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
    enumDescriptions: [
      'suppress markup',
      'equation-level',
      'within equations',
      'small changes inside equations',
    ],
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly),
    description:
      'Produce a changes-only diff (show only the parts that changed) rather than the full marked-up document.',
    category: 'latexdiff',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'latex',
  }),

  // --- LaTeX formatter -------------------------------------------------------
  // Invoked via LatexDiffManager during the reflection flow (which the CLI runs),
  // i.e. coupled to the latexdiff path that's deferred from the CLI roster, so
  // it stays vscode/desktop only for now.
  stateSetting({
    key: WorkspaceStateKey.LATEX_FORMATTER,
    schema: z
      .enum(LATEX_FORMATTER_VALUES)
      .prefault(LATEX_CONFIG_DEFAULTS.latexFormatter),
    description: 'Which formatter to run when formatting LaTeX source.',
    category: 'latex',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
    enumDescriptions: [
      'Format with latexindent.',
      'Format with tex-fmt.',
      'Do not run any formatter.',
    ],
    settingsViewSnapshot: 'latex',
  }),

  // --- OpenAI WebSocket transport (experimental) -----------------------------
  // Read by `getWebSocketEnabled()` and consumed by the OpenAI Responses handler
  // the CLI runs. Enables the persistent WebSocket transport for the direct
  // OpenAI endpoint — and, experimentally, lets the ChatGPT-subscription Codex
  // backend attempt WebSocket. Surfaced to the CLI so it can be toggled and
  // tested there.
  stateSetting({
    key: GlobalStateKey.WEBSOCKET_OPENAI,
    schema: z.boolean().prefault(false),
    title: 'OpenAI WebSocket',
    description:
      'EXPERIMENTAL: use the persistent WebSocket transport for OpenAI Responses requests (lower latency for tool-use loops), and let the ChatGPT-subscription Codex backend attempt WebSocket. Off by default.',
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: 'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
    cliRuntimeReachability: OPENAI_WEBSOCKET_RUNTIME_REACHABILITY,
  }),

  // --- Provider endpoints ---------------------------------------------------
  // The extension/desktop Models tab already has per-provider endpoint inputs.
  // The CLI consumes the same global-state keys in `ProxyConfigResolver`, so
  // these rows expose that existing runtime behavior through `/config` without
  // adding another imperative settings list.
  ...PROVIDER_ENDPOINT_SETTINGS,

  // --- OpenRouter routing ----------------------------------------------------
  // Read by `getUseOpenRouter()` during model-handler routing. The extension
  // and desktop already surface the same setting through provider settings; the
  // catalog row is CLI-only so later settings-view catalog rendering does not
  // duplicate that existing control.
  stateSetting({
    key: GlobalStateKey.USE_OPENROUTER,
    schema: z.boolean().prefault(false),
    title: USE_OPENROUTER_PROVIDER_SETTING.label,
    description: USE_OPENROUTER_PROVIDER_SETTING.description,
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: 'src/utils/config/providerConfig.ts',
    cliRuntimeReachability: OPENROUTER_ROUTING_RUNTIME_REACHABILITY,
  }),

  // --- Provider routing & region toggles --------------------------------------
  // Same idiom as the OpenRouter row above: every toggle stays in
  // PROVIDER_SETTINGS for the Models tab, and the
  // catalog row is CLI-only so later settings-view catalog rendering does not
  // duplicate those existing controls. Label/description are reused by
  // reference from the named provider-setting consts; `.prefault()` matches
  // the provider setting's `defaultValue` (absent = false) — both pinned
  // against the live getters by the guardrail suite. The Kimi Code prefer
  // switch is read by `getPreferKimiCode()` during model-handler dispatch.
  stateSetting({
    key: GlobalStateKey.KIMI_CODE_PREFER,
    schema: z.boolean().prefault(false),
    title: KIMI_CODE_PREFER_PROVIDER_SETTING.label,
    description: KIMI_CODE_PREFER_PROVIDER_SETTING.description,
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: 'src/agent/runtime/ModelFactory.ts',
    cliRuntimeReachability: KIMI_CODE_ROUTING_RUNTIME_REACHABILITY,
  }),
  ...PROVIDER_ROUTING_SETTINGS,

  // --- External tool integrations ------------------------------------------
  // This is a list-backed global-state domain. `/config` delegates editing to
  // the existing `/tools` form so the catalog owns discoverability while the
  // tool dashboard remains the single editor for per-integration toggles.
  stateSetting({
    key: GlobalStateKey.DISABLED_TOOLS,
    schema: z.array(z.string()).prefault([]),
    title: 'Tool integrations',
    description:
      'Enable or disable external tool integration groups used by agent tool resolution.',
    category: 'tools',
    store: 'globalState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: 'src/tools/toolAvailability.ts',
    cliRuntimeReachability: TOOL_AVAILABILITY_RUNTIME_REACHABILITY,
    openForm: 'tools',
  }),
  stateSetting({
    key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
    schema: z.boolean().prefault(DEFAULT_TOOL_PATH_PROTECTION_ENABLED),
    title: 'Restrict tool paths',
    description:
      'Keep file-reading, editing, search, diagnostics, and PDF tools inside the active working directory. Turn this off only when an agent must use arbitrary filesystem paths.',
    category: 'tools',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: 'src/tools/pathResolution.ts',
    cliRuntimeReachability: TOOL_PATH_PROTECTION_RUNTIME_REACHABILITY,
    settingsViewSnapshot: 'approval',
  }),
];

/** Every canonical `texra.*` key in the catalog. */
export const STATE_SETTING_KEYS: readonly string[] = STATE_SETTINGS.map(
  (entry) => entry.key,
);

const STATE_SETTINGS_BY_KEY: ReadonlyMap<string, StateSettingEntry> = new Map(
  STATE_SETTINGS.map((entry) => [entry.key, entry]),
);

// These rows already belong to CoreSettingsShape, so they must not enter the
// state-backed catalog above. They carry only the storage and rebroadcast
// metadata needed by the settings view's unified scalar-write boundary.
// Exported so host rosters and the guardrail suite can iterate the full
// catalog (state-backed plus settings-view rows) in one place. Typed at the
// catalog-entry level (not `as const`) so `hosts.includes('cli')` checks
// compile against the widened `SettingHost` union.
export const SETTINGS_VIEW_CORE_SETTINGS: readonly StateSettingEntry[] = [
  stateSetting({
    key: 'texra.latex.wrapCritiqueInAlign',
    schema: CoreSettingsShape.latex.unwrap().shape.wrapCritiqueInAlign,
    title: 'Wrap criticism in align environments',
    description:
      'Wrap bare criticism and comment commands inside align environments with intertext.',
    category: 'latex',
    store: 'config',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: 'texra.latex.enabledReplacements',
    schema: CoreSettingsShape.latex.unwrap().shape.enabledReplacements,
    title: 'Literal replacement groups',
    description: 'Enabled groups of direct LaTeX cleanup replacements.',
    category: 'latex',
    store: 'config',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: 'texra.latex.enabledReplacementsRegex',
    schema: CoreSettingsShape.latex.unwrap().shape.enabledReplacementsRegex,
    title: 'Pattern replacement groups',
    description: 'Enabled groups of pattern-based LaTeX cleanup replacements.',
    category: 'latex',
    store: 'config',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: 'texra.latex.customReplacementsRegex',
    schema: CoreSettingsShape.latex.unwrap().shape.customReplacementsRegex,
    title: 'Custom pattern replacements',
    description: 'Custom regular-expression replacements.',
    category: 'latex',
    store: 'config',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: 'texra.latex.customReplacements',
    schema: CoreSettingsShape.latex.unwrap().shape.customReplacements,
    title: 'Custom literal replacements',
    description: 'Custom direct text replacements.',
    category: 'latex',
    store: 'config',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'latex',
  }),
  stateSetting({
    key: TOOL_EDIT_APPROVAL_CONFIG_KEY,
    schema: CoreSettingsShape.toolUse.unwrap().shape.requireEditApproval,
    title: 'Under Ask: require approval for file edits',
    description:
      'When approval policy is Ask, show a diff before an agent changes workspace files. Inert under Never and Auto-approve.',
    category: 'tools',
    store: 'config',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'approval',
  }),
  stateSetting({
    key: BASH_APPROVAL_CONFIG_KEY,
    schema: CoreSettingsShape.toolUse.unwrap().shape.requireBashApproval,
    title: 'Under Ask: require approval for shell commands',
    description:
      'When approval policy is Ask, pause before an agent runs a shell command. Inert under Never and Auto-approve.',
    category: 'tools',
    store: 'config',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'approval',
  }),
  stateSetting({
    key: TEXRA_APPROVAL_POLICY_CONFIG_KEY,
    schema: TexraApprovalPolicySchema.prefault(TEXRA_APPROVAL_POLICY_DEFAULT),
    title: 'Approval policy',
    description:
      'Deny, ask, or auto-approve Bash and tool edits for this workspace. Under Ask, the two toggles below control each kind independently.',
    category: 'tools',
    store: 'config',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: 'packages/cli/src/runtime/cliConfig.ts',
    cliRuntimeReachability: TEXRA_APPROVAL_POLICY_RUNTIME_REACHABILITY,
    enumLabels: ['Never', 'Ask', 'Auto-approve'],
    settingsViewSnapshot: 'approval',
  }),
  stateSetting({
    key: AGENT_SKILLS_CONFIG_KEY,
    schema: CoreSettingsShape.skills.unwrap().shape.enabled,
    title: 'Agent skills',
    description:
      'Discover TeXRA and imported skills and expose them to tool-use agent prompts.',
    category: 'tools',
    store: 'config',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: 'src/agent/prompt/userVars.ts',
    cliRuntimeReachability: AGENT_SKILLS_RUNTIME_REACHABILITY,
    settingsViewSnapshot: 'agent-skills',
  }),
  stateSetting({
    key: CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
    schema: CoreSettingsShape.childRunConcurrencyBudget,
    title: 'Child-run concurrency budget',
    description: CHILD_RUN_CONCURRENCY_BUDGET_SETTING.description,
    category: 'multi-agent',
    store: 'config',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'multi-agent',
  }),
  stateSetting({
    key: 'texra.telemetry.enabled',
    schema: CoreSettingsShape.telemetry.unwrap().shape.enabled,
    title: 'Usage telemetry',
    description:
      'Send model, token, cost, timing, route, and host metadata. TeXRA never sends prompt text, document content, or file names.',
    category: 'account',
    store: 'config',
    configTarget: 'global',
    hosts: ['vscode', 'desktop'],
    settingsViewSnapshot: 'telemetry',
  }),
];

const SETTINGS_VIEW_SETTINGS_BY_KEY: ReadonlyMap<
  string,
  SettingsViewStateSettingEntry
> = new Map(
  [...STATE_SETTINGS, ...SETTINGS_VIEW_CORE_SETTINGS]
    .filter(
      (entry): entry is SettingsViewStateSettingEntry =>
        entry.settingsViewSnapshot !== undefined,
    )
    .map((entry) => [entry.key, entry]),
);

/** Look up a catalog entry by its canonical `texra.*` key. */
export function stateSettingByKey(key: string): StateSettingEntry | undefined {
  return STATE_SETTINGS_BY_KEY.get(key);
}

/** Look up a scalar setting owned by the settings view's unified write path. */
export function settingsViewSettingByKey(
  key: string,
): SettingsViewStateSettingEntry | undefined {
  return SETTINGS_VIEW_SETTINGS_BY_KEY.get(key);
}

/**
 * The single canonical "CLI roster" — catalog entries the CLI consumes,
 * spanning both the state-backed catalog and the settings-view core rows
 * (e.g. Agent skills, which the CLI reads from `texra.skills.enabled` in
 * config). Both the `/config` panel and any key-list derivation come from
 * this one filter so the `hosts.includes('cli')` predicate lives in exactly
 * one place.
 */
export const CLI_STATE_SETTINGS: readonly StateSettingEntry[] = [
  ...STATE_SETTINGS,
  ...SETTINGS_VIEW_CORE_SETTINGS,
].filter((entry) => entry.hosts.includes('cli'));

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
