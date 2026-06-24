// Third-party imports
import { z } from 'zod';

// Local imports - shared constants & state keys
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_MARK_COMMITS,
} from '@shared/constants/git';
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
  LATEX_FORMATTER_VALUES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latex';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

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
export type SettingHost = 'vscode' | 'cli' | 'desktop';

/** Storage slot a setting is read from / written to. */
export type SettingStore = 'config' | 'workspaceState' | 'globalState';

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
  /** Allowed values for enum settings — drives the inner value picker. */
  readonly enumValues?: readonly string[];
  /** Per-value descriptions, aligned 1:1 with {@link enumValues}. */
  readonly enumDescriptions?: readonly string[];
  /**
   * Delegate editing to an existing list form (e.g. `ModelListForm`) instead of
   * the scalar read/write accessor.
   */
  readonly openForm?: string;
}

const GIT_AUTHOR_CONSUMER = 'packages/cli/src/runtime/gitAuthor.ts';

export const STATE_SETTINGS: readonly StateSettingEntry[] = [
  // --- Git commit author marking ---------------------------------------------
  // Stored in worktree-shared WorkspaceState by the extension; read from
  // `.texra/config.json` by the CLI (hence `cliStore: 'config'`).
  {
    key: WorkspaceStateKey.GIT_MARK_COMMITS,
    schema: z.boolean().prefault(DEFAULT_GIT_MARK_COMMITS),
    description:
      'Attribute agent-authored git commits to the TeXRA identity so they are distinguishable from your own commits.',
    category: 'git',
    store: 'workspaceState',
    cliStore: 'config',
    hosts: ['vscode', 'cli', 'desktop'],
    cliConsumer: GIT_AUTHOR_CONSUMER,
  },
  {
    key: WorkspaceStateKey.GIT_AUTHOR_NAME,
    schema: z.string().prefault(DEFAULT_GIT_AUTHOR_NAME),
    description:
      'Author and committer name used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    store: 'workspaceState',
    cliStore: 'config',
    hosts: ['vscode', 'cli', 'desktop'],
    cliConsumer: GIT_AUTHOR_CONSUMER,
  },
  {
    key: WorkspaceStateKey.GIT_AUTHOR_EMAIL,
    schema: z.string().prefault(DEFAULT_GIT_AUTHOR_EMAIL),
    description:
      'Author and committer email used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    store: 'workspaceState',
    cliStore: 'config',
    hosts: ['vscode', 'cli', 'desktop'],
    cliConsumer: GIT_AUTHOR_CONSUMER,
  },
  {
    key: WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
    schema: z.boolean().prefault(false),
    description:
      'Allow spawned subagents to run in isolated git worktrees so parallel edits do not conflict.',
    category: 'git',
    store: 'workspaceState',
    cliStore: 'config',
    hosts: ['vscode', 'cli', 'desktop'],
    cliConsumer: GIT_AUTHOR_CONSUMER,
  },

  // --- Workflow auto-compile -------------------------------------------------
  // Consumed today by the VS Code extension + desktop only (no CLI consumer
  // yet); a later PR adds the CLI read path and flips `hosts` to include 'cli'.
  {
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompile),
    description:
      'Compile the LaTeX project automatically after an agent writes its output.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
  },
  {
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
    schema: z
      .number()
      .min(LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min)
      .prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs),
    description:
      'Maximum time (in milliseconds) to wait for an automatic post-output compile before giving up.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
  },
  {
    key: WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoOpenPdf),
    description:
      'Open the compiled PDF automatically after a successful auto-compile.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
  },
  {
    key: WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
    schema: z
      .boolean()
      .prefault(LATEX_CONFIG_DEFAULTS.workflowRejectOnCompileFailure),
    description:
      'Reject an agent edit when the automatic post-output compile fails, so broken LaTeX is not accepted.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
  },

  // --- LaTeXdiff -------------------------------------------------------------
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
    enumValues: LATEXDIFF_MATH_MARKUP_VALUES,
    enumDescriptions: [
      'Do not mark up changes inside math at all.',
      'Mark a whole math environment as changed if anything inside it changed.',
      'Mark up changes at a coarse granularity inside math (recommended).',
      'Mark up changes at the finest granularity inside math.',
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
  {
    key: WorkspaceStateKey.LATEX_FORMATTER,
    schema: z
      .enum(LATEX_FORMATTER_VALUES)
      .prefault(LATEX_CONFIG_DEFAULTS.latexFormatter),
    description: 'Which formatter to run when formatting LaTeX source.',
    category: 'latex',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop'],
    enumValues: LATEX_FORMATTER_VALUES,
    enumDescriptions: [
      'Format with latexindent.',
      'Format with tex-fmt.',
      'Do not run any formatter.',
    ],
  },
] as const;

/** Every canonical `texra.*` key in the catalog. */
export const STATE_SETTING_KEYS: readonly string[] = STATE_SETTINGS.map(
  (entry) => entry.key,
);

/** Catalog keys whose consuming hosts include the CLI. */
export const CLI_STATE_SETTING_KEYS: readonly string[] = STATE_SETTINGS.filter(
  (entry) => entry.hosts.includes('cli'),
).map((entry) => entry.key);
