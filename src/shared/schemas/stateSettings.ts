// Third-party imports
import { z } from 'zod';

// Local imports - shared constants & state keys
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_MARK_COMMITS,
  DEFAULT_GIT_WORKTREE_SUPPORT,
} from '@shared/constants/git';
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
  LATEX_FORMATTER_VALUES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latex';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';

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
  /**
   * Per-value descriptions for an enum setting, aligned 1:1 with the schema's
   * enum options (see {@link settingEnumOptions}). The option *values* are
   * derived from the schema, not restated here.
   */
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
    schema: z.boolean().prefault(DEFAULT_GIT_WORKTREE_SUPPORT),
    description:
      'Allow spawned subagents to run in isolated git worktrees so parallel edits do not conflict.',
    category: 'git',
    store: 'workspaceState',
    cliStore: 'config',
    hosts: ['vscode', 'cli', 'desktop'],
    cliConsumer: GIT_AUTHOR_CONSUMER,
  },

  // --- Workflow auto-compile -------------------------------------------------
  // The CLI runs workflow (reflection) agents via `texra workflow` / `texra
  // run`, so these take effect there as well as in the extension/desktop. The
  // exception is auto-open-pdf: it emits `requestOpenFile`, which the headless
  // CLI has no handler for, so it stays off the CLI roster.
  {
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompile),
    description:
      'Compile the LaTeX project automatically after an agent writes its output.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: 'src/agent/output/compileCheck.ts',
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
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer: 'src/agent/output/compileCheck.ts',
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
    description:
      'Reject an agent edit when the automatic post-output compile fails, so broken LaTeX is not accepted.',
    category: 'workflow',
    store: 'workspaceState',
    hosts: ['vscode', 'desktop', 'cli'],
    cliConsumer:
      'src/agent/implementations/flows/reflection/runReflectionFlow.ts',
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
    description:
      'EXPERIMENTAL: use the persistent WebSocket transport for OpenAI Responses requests (lower latency for tool-use loops), and let the ChatGPT-subscription Codex backend attempt WebSocket. Off by default.',
    category: 'model',
    store: 'globalState',
    hosts: ['cli'],
    cliConsumer: 'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
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
