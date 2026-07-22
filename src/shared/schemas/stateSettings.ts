// Third-party imports
import { z } from 'zod';

// Local imports - shared constants & state keys
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
  LATEX_FORMATTER_VALUES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latex';
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
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  ClaudeAgentEffortSchema,
  ClaudeAgentModelSchema,
  ClaudeAgentPermissionModeSchema,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
  CodexApprovalPolicySchema,
  CodexReasoningEffortSchema,
  CodexSandboxModeSchema,
} from '@shared/schemas/agentCliSettings';
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
 * Host-neutral catalog for **state-backed** TeXRA settings.
 *
 * Unlike {@link CoreSettingsShape} (config-tree settings that flow into the VS
 * Code `contributes.configuration` block), these keys are read from
 * WorkspaceState / GlobalState — they were deliberately migrated *out* of VS
 * Code config (see `LATEX_SETTINGS_MIGRATED`). Putting them in
 * `CoreSettingsShape` would emit phantom VS Code configuration the extension
 * never reads, so they live here as metadata-only rows instead.
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
  /** Short label for compact settings UIs; falls back to the stripped key. */
  readonly title?: string;
  /** Human-readable description, shared across every host that renders it. */
  readonly description: string;
  /** Grouping label for settings UIs. */
  readonly category: string;
  /** Canonical (extension) storage slot. */
  readonly store: SettingStore;
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
}

const GIT_AUTHOR_CONSUMER = 'packages/cli/src/runtime/gitAuthor.ts';
const CODEX_CONFIG_CONSUMER = 'src/tools/codexConfig.ts';
const CLAUDE_AGENT_CONFIG_CONSUMER = 'src/tools/claudeAgentConfig.ts';
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
    'packages/cli/src/runtime/initPlatform.ts -> packages/cli/src/runtime/gitAuthor.ts -> src/tools/DelegationTools.ts',
} satisfies CliRuntimeReachability;
const WORKFLOW_COMPILE_RUNTIME_REACHABILITY = {
  command:
    'texra run <workflow-agent> --input paper.tex --instruction "revise the paper"',
  through:
    'packages/cli/src/commands/workflow.ts -> src/agent/output/compileCheck.ts',
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

const PROXY_CONFIG_CONSUMER =
  'src/agent/modelHandlers/support/ProxyConfigResolver.ts';

const PROVIDER_ENDPOINT_SETTINGS = PROVIDER_ENDPOINT_STATE_ENTRIES.map(
  ({ endpointKey, displayName }) =>
    ({
      key: endpointKey,
      schema: z.string().prefault(''),
      title: `${displayName} endpoint`,
      description: `Custom base URL for ${displayName} API requests. Leave empty to use the default endpoint.`,
      category: 'model',
      store: 'globalState',
      hosts: ['cli'],
      cliConsumer: PROXY_CONFIG_CONSUMER,
      cliRuntimeReachability: PROVIDER_ENDPOINT_RUNTIME_REACHABILITY,
    }) satisfies StateSettingEntry,
);

export const STATE_SETTINGS: readonly StateSettingEntry[] = [
  // --- Git commit author marking ---------------------------------------------
  // Stored in worktree-shared WorkspaceState by the extension; read from
  // `.texra/config.json` by the CLI (hence `cliStore: 'config'`).
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },

  // --- External coding agent controls ---------------------------------------
  // These are workspace-shared settings read by the Codex and Claude Code tool
  // integrations. The CLI reaches them through headless tool-use runs, so the
  // same catalog drives both the extension/desktop settings view and `/config`.
  {
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
  },
  {
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
  },
  {
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
  },
  {
    key: WorkspaceStateKey.CLAUDE_AGENT_MODEL,
    schema: ClaudeAgentModelSchema.prefault(CLAUDE_AGENT_DEFAULT_MODEL),
    title: 'Claude Code model',
    description: 'Claude model selected for Claude Code agent sessions.',
    category: 'ai-agents',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: CLAUDE_AGENT_CONFIG_CONSUMER,
    cliRuntimeReachability: CLAUDE_AGENT_RUNTIME_REACHABILITY,
    enumLabels: ['Sonnet 5', 'Fable 5', 'Opus 4.8', 'Haiku 4.5'],
  },
  {
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
  },
  {
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
  },

  // --- Workflow auto-compile -------------------------------------------------
  // The CLI runs workflow (reflection) agents via `texra workflow` / `texra
  // run`, so these take effect there as well as in the extension/desktop. The
  // exception is auto-open-pdf: it emits `requestOpenFile`, which the headless
  // CLI has no handler for, so it stays off the CLI roster.
  {
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompile),
    title: 'Auto-compile outputs',
    description:
      'Compile the LaTeX project automatically after an agent writes its output.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: 'src/agent/output/compileCheck.ts',
    cliRuntimeReachability: WORKFLOW_COMPILE_RUNTIME_REACHABILITY,
  },
  {
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
    schema: z
      .number()
      .min(LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min)
      .prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs),
    title: 'Auto-compile timeout',
    description:
      'Maximum time (in milliseconds) to wait for an automatic post-output compile before giving up.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: 'src/agent/output/compileCheck.ts',
    cliRuntimeReachability: WORKFLOW_COMPILE_RUNTIME_REACHABILITY,
  },
  {
    key: WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoOpenPdf),
    description:
      'Open the compiled PDF automatically after a successful auto-compile.',
    category: 'workflow',
    store: 'workspaceState',
    // Read by OutputNode but the emitted `requestOpenFile` has no CLI handler
    // (headless), so toggling it would be a no-op there — vscode/desktop only.
    hosts: ['vscode', 'desktop'],
  },
  {
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
  },

  // --- LaTeXdiff -------------------------------------------------------------
  // Run by the reflection flow (so the CLI executes them), but deferred from the
  // CLI roster for now per product decision — not surfaced in `/config`.
  {
    key: WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds),
    description:
      'Generate a latexdiff between successive reflection rounds, not just against the original input.',
    category: 'latexdiff',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
  },
  {
    key: WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
    schema: z
      .number()
      .min(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.min)
      .max(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.max)
      .prefault(LATEX_CONFIG_DEFAULTS.latexdiffTimeoutMs),
    description:
      'Maximum time (in milliseconds) to allow a single latexdiff invocation to run.',
    category: 'latexdiff',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
  },
  {
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
  },
  {
    key: WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly),
    description:
      'Produce a changes-only diff (show only the parts that changed) rather than the full marked-up document.',
    category: 'latexdiff',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
  },

  // --- LaTeX formatter -------------------------------------------------------
  // Invoked via LatexDiffManager during the reflection flow (which the CLI runs),
  // i.e. coupled to the latexdiff path that's deferred from the CLI roster, so
  // it stays vscode/desktop only for now.
  {
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
  },

  // --- OpenAI WebSocket transport (experimental) -----------------------------
  // Read by `getWebSocketEnabled()` and consumed by the OpenAI Responses handler
  // the CLI runs. Enables the persistent WebSocket transport for the direct
  // OpenAI endpoint — and, experimentally, lets the ChatGPT-subscription Codex
  // backend attempt WebSocket. Surfaced to the CLI so it can be toggled and
  // tested there.
  {
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
  },

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
  {
    key: GlobalStateKey.USE_OPENROUTER,
    schema: z.boolean().prefault(false),
    title: USE_OPENROUTER_PROVIDER_SETTING.label,
    description: USE_OPENROUTER_PROVIDER_SETTING.description,
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: 'src/utils/config/providerConfig.ts',
    cliRuntimeReachability: OPENROUTER_ROUTING_RUNTIME_REACHABILITY,
  },

  // --- Provider routing & region toggles --------------------------------------
  // Same idiom as the OpenRouter row above: every toggle stays in
  // PROVIDER_VSCODE_SETTINGS for the extension/desktop Models tab, and the
  // catalog row is CLI-only so later settings-view catalog rendering does not
  // duplicate those existing controls. Label/description are reused by
  // reference from the named provider-setting consts; `.prefault()` matches
  // the provider setting's `defaultValue` (absent = false) — both pinned
  // against the live getters by the guardrail suite. The Kimi Code prefer
  // switch is read by `getPreferKimiCode()` during model-handler dispatch.
  {
    key: GlobalStateKey.KIMI_CODE_PREFER,
    schema: z.boolean().prefault(false),
    title: KIMI_CODE_PREFER_PROVIDER_SETTING.label,
    description: KIMI_CODE_PREFER_PROVIDER_SETTING.description,
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: 'src/agent/runtime/ModelFactory.ts',
    cliRuntimeReachability: KIMI_CODE_ROUTING_RUNTIME_REACHABILITY,
  },
  {
    key: GlobalStateKey.MOONSHOT_USE_CHINA,
    schema: z.boolean().prefault(true),
    title: MOONSHOT_USE_CHINA_PROVIDER_SETTING.label,
    description: MOONSHOT_USE_CHINA_PROVIDER_SETTING.description,
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: PROXY_CONFIG_CONSUMER,
    cliRuntimeReachability: PROVIDER_REGION_RUNTIME_REACHABILITY,
  },
  {
    key: GlobalStateKey.DASHSCOPE_USE_CHINA,
    schema: z.boolean().prefault(false),
    title: DASHSCOPE_USE_CHINA_PROVIDER_SETTING.label,
    description: DASHSCOPE_USE_CHINA_PROVIDER_SETTING.description,
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: PROXY_CONFIG_CONSUMER,
    cliRuntimeReachability: PROVIDER_REGION_RUNTIME_REACHABILITY,
  },
  {
    key: GlobalStateKey.MINIMAX_USE_CHINA,
    schema: z.boolean().prefault(false),
    title: MINIMAX_USE_CHINA_PROVIDER_SETTING.label,
    description: MINIMAX_USE_CHINA_PROVIDER_SETTING.description,
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: PROXY_CONFIG_CONSUMER,
    cliRuntimeReachability: PROVIDER_REGION_RUNTIME_REACHABILITY,
  },
  {
    key: GlobalStateKey.GLM_USE_CHINA,
    schema: z.boolean().prefault(true),
    title: GLM_USE_CHINA_PROVIDER_SETTING.label,
    description: GLM_USE_CHINA_PROVIDER_SETTING.description,
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: PROXY_CONFIG_CONSUMER,
    cliRuntimeReachability: PROVIDER_REGION_RUNTIME_REACHABILITY,
  },
  {
    key: GlobalStateKey.GLM_CODING_PLAN,
    schema: z.boolean().prefault(false),
    title: GLM_CODING_PLAN_PROVIDER_SETTING.label,
    description: GLM_CODING_PLAN_PROVIDER_SETTING.description,
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: PROXY_CONFIG_CONSUMER,
    cliRuntimeReachability: PROVIDER_REGION_RUNTIME_REACHABILITY,
  },

  // --- External tool integrations ------------------------------------------
  // This is a list-backed global-state domain. `/config` delegates editing to
  // the existing `/tools` form so the catalog owns discoverability while the
  // tool dashboard remains the single editor for per-integration toggles.
  {
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
  },
] as const;

/** Every canonical `texra.*` key in the catalog. */
export const STATE_SETTING_KEYS: readonly string[] = STATE_SETTINGS.map(
  (entry) => entry.key,
);

const STATE_SETTINGS_BY_KEY: ReadonlyMap<string, StateSettingEntry> = new Map(
  STATE_SETTINGS.map((entry) => [entry.key, entry]),
);

/** Look up a catalog entry by its canonical `texra.*` key. */
export function stateSettingByKey(key: string): StateSettingEntry | undefined {
  return STATE_SETTINGS_BY_KEY.get(key);
}

/**
 * The single canonical "CLI roster" — catalog entries the CLI consumes. Both
 * the `/config` panel and any key-list derivation come from this one filter so
 * the `hosts.includes('cli')` predicate lives in exactly one place.
 */
export const CLI_STATE_SETTINGS: readonly StateSettingEntry[] =
  STATE_SETTINGS.filter((entry) => entry.hosts.includes('cli'));

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
