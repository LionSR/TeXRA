/**
 * The tool plugin manifest — the one list every tool belongs to: a stable id
 * plus dashboard copy, the opt-in toggle, the availability probe and the
 * install/auth actions. Implementations live in `@tools/registry`, which maps
 * each plugin id to its tool objects and fails the build when those names
 * differ from `toolNames` here; keeping implementations out keeps this
 * module's closure (and its readers') small.
 *
 * Derived from this list: the Tools dashboard (in list order), availability
 * probes, the first-install toggle seed, switched-off plugins and a run's
 * injected tools (`@tools/composition`), install/auth terminal actions,
 * `texra tools` guides, and the skill roots the host bootstrap installs in
 * the bundled tier for each `skills` plugin, not gated by switch or probe.
 *
 * Rules: an id is persisted (the disabled-tools key), so it never changes and
 * is never reused; every tool belongs to exactly one plugin (checked below
 * and in the registry). No hooks, task kinds or event channels, and no state
 * but a `layer`: a plugin is data, re-registered by code at every startup.
 */

// Local imports
import type { ToolCategory } from '@shared/settingsView/settingsViewMessages';
import { DELEGATE_MULTI_AGENTS_TOOL_NAME } from '@shared/constants/delegationTools';
import { GOAL_FEATURE_FLAG_KEY } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  MAX_CONCURRENT_PR_SUBSCRIPTIONS,
  MAX_CONCURRENT_REPO_SUBSCRIPTIONS,
  GITHUB_POLL_INTERVAL_MS,
} from '@tools/github/prSubscriptionConstants';
import { LEAN4_EXTENSION_ID } from '@tools/lean/leanTypes';
import {
  ALWAYS_AVAILABLE,
  CLAUDE_CODE_AVAILABILITY,
  CODEX_AVAILABILITY,
  GITHUB_AVAILABILITY,
  LEAN4_AVAILABILITY,
  TEXCOUNT_AVAILABILITY,
  WOLFRAM_AVAILABILITY,
  ZOTERO_AVAILABILITY,
} from '@tools/pluginAvailability';
import {
  preferredInstallCommand,
  type ToolAvailabilityChecks,
} from '@tools/toolProbes';

/** One tool plugin. */
export interface ToolPlugin {
  /** Stable, persisted identifier (the dashboard item id and toggle key). */
  readonly id: string;
  /** The registered tools this plugin provides; `@tools/registry` checks them. */
  readonly toolNames: readonly [string, ...string[]];
  /**
   * Present when the plugin has an external dependency: it is probed, its
   * tools are withheld while the dependency is missing, and the dashboard
   * shows its status and install actions. Without it the plugin is built in
   * and always available.
   */
  readonly availability?: ToolAvailabilityChecks;
  readonly name: string;
  readonly category: ToolCategory;
  readonly description: string;
  /** Checked for availability but listed on no Tools dashboard. */
  readonly hidden?: boolean;
  /** Tools of this plugin offered to every tool-use agent, declared or not,
   *  while a boolean catalog setting is on: tool name to setting key. An
   *  injected tool still passes the host and approval gates; reflection
   *  runs get none. */
  readonly injectedWhen?: Readonly<Record<string, string>>;
  /** Opt-in: the dashboard shows an enable/disable toggle, a fresh install
   *  seeds the plugin disabled, and while disabled its tools are withheld
   *  from every agent. */
  readonly toggleable?: boolean;
  /** Owns resources: a layer in `@tools/registry`, built while an open
   *  composition includes the plugin (`@tools/compositions`). */
  readonly layer?: true;
  /** Ships skills at `resources/plugins/<id>/skills` (see the header). */
  readonly skills?: true;
  readonly installGuide?: string;
  readonly installUrl?: string;
  /** VS Code extension ID — when present, the dashboard offers a direct "Install" button. */
  readonly installExtensionId?: string;
  /** Shell command the dashboard can run in an integrated terminal to install the tool. */
  readonly installCommand?: string;
  /** Shell command the dashboard can run to sign the user in (e.g. `codex login`). */
  readonly authCommand?: string;
  readonly configNotes?: string;
  /** Short auth/billing note shown as a badge (e.g. "Uses ChatGPT subscription"). */
  readonly authNote?: string;
}

const MANIFEST = [
  {
    id: 'file-ops',
    toolNames: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
    name: 'File & Shell Operations',
    category: 'file',
    description:
      'Read, write, edit files and run shell commands. Includes glob/grep search.',
  },
  {
    id: 'latex-extract',
    toolNames: [
      'extract_figures',
      'extract_tikz_figures',
      'extract_bib_entries',
    ],
    name: 'LaTeX Extraction',
    category: 'latex',
    description:
      'Extract figures, TikZ diagrams, and bibliography entries from LaTeX documents.',
  },
  {
    id: 'latex-diagnostics',
    toolNames: ['diagnostics'],
    name: 'LaTeX Diagnostics',
    category: 'latex',
    description:
      'Report LaTeX compilation errors and warnings from the VS Code Problems panel.',
  },
  {
    id: 'arxiv',
    toolNames: ['arxiv_search', 'arxiv_metadata', 'download_arxiv_source'],
    name: 'ArXiv Search & Download',
    category: 'academic',
    description:
      'Search arXiv papers, retrieve metadata, and download LaTeX source packages.',
  },
  {
    id: 'crossref',
    toolNames: ['crossref_search'],
    name: 'Crossref Citation Lookup',
    category: 'academic',
    description:
      'Search Crossref for academic publications by query or resolve DOIs to full metadata.',
  },
  {
    id: 'web',
    toolNames: ['web_search', 'web_fetch'],
    name: 'Web Search & Fetch',
    category: 'web',
    description:
      'Search the web with DuckDuckGo Instant Answers and fetch or extract content from URLs.',
  },
  {
    id: 'memory-workflow',
    toolNames: [
      'memory',
      'todo_write',
      'plan',
      'delegate_workflow',
      'delegate_agent',
      'executions',
      'accept_run_files',
    ],
    injectedWhen: {
      memory: GlobalStateKey.MEMORY_ENABLED,
      // The `plan` tool owns planning and the goal lifecycle (update, pause,
      // complete), so any tool-use agent can drive the goal loop while goal
      // is on. The goal continuation itself is the tool-use loop's
      // (`maybeBuildGoalContinuation`), not an injection.
      plan: GOAL_FEATURE_FLAG_KEY,
    },
    name: 'Memory, Tasks & Delegation',
    category: 'workflow',
    description:
      'Persistent memory across sessions, task tracking with to-do lists, and delegate work to sub-agents.',
  },
  {
    id: 'texcount',
    toolNames: ['texcount'],
    name: 'TeXcount',
    category: 'latex',
    description:
      'Count words, headers, figures, and other elements in LaTeX documents.',
    installGuide:
      'TeXcount is a Perl script for counting words in LaTeX files.\n\n' +
      'Installation:\n' +
      '  Mac:     brew install texcount\n' +
      '  Ubuntu:  sudo apt-get install texlive-extra-utils\n' +
      '  Windows: Install via MiKTeX or TeX Live package manager',
    installUrl: 'https://app.uio.no/ifi/texcount/',
    configNotes: 'Part of most TeX Live distributions.',
    hidden: true, // Shown in LaTeX settings tab instead
    availability: TEXCOUNT_AVAILABILITY,
  },
  {
    id: 'wolfram',
    toolNames: ['wolfram'],
    name: 'Wolfram Language',
    category: 'computation',
    description:
      'Execute Wolfram Language code for symbolic math, computation, and data analysis.',
    installGuide:
      'Requires the "wolframscript" command-line tool.\n\n' +
      'Install the free Wolfram Engine:\n' +
      '  Mac:     brew install --cask wolfram-engine\n' +
      '  Ubuntu:  Download from wolfram.com/engine\n' +
      '  Windows: Download from wolfram.com/engine\n\n' +
      'Note: A Mathematica installation alone is not enough: you\n' +
      'need WolframScript on your PATH. The Wolfram Engine includes\n' +
      'it automatically. Free licenses are available for development use.',
    installUrl: 'https://www.wolfram.com/engine/',
    configNotes: 'Requires the free Wolfram Engine (provides wolframscript).',
    availability: WOLFRAM_AVAILABILITY,
  },
  {
    id: 'zotero',
    toolNames: [
      'zotero_collections',
      'zotero_search',
      'zotero_add',
      'zotero_export',
    ],
    name: 'Zotero Integration',
    category: 'ai-agents',
    description:
      'Search, add items to, and export citations from your Zotero library. Requires Better BibTeX plugin.',
    installGuide:
      'Requires Zotero with the Better BibTeX plugin installed.\n\n' +
      'Setup:\n' +
      '  1. Install Zotero (zotero.org)\n' +
      '  2. Install Better BibTeX plugin:\n' +
      '     - Download from retorque.re/zotero-better-bibtex\n' +
      '     - In Zotero: Tools > Add-ons > Install from File\n' +
      '  3. Keep Zotero running while using TeXRA\n\n' +
      'Better BibTeX exposes a JSON-RPC API on localhost:23119\n' +
      'that TeXRA uses to communicate with your library.',
    installUrl: 'https://retorque.re/zotero-better-bibtex/installation/',
    configNotes:
      'Zotero must be running with Better BibTeX installed. Port configurable via texra.bib.zoteroPort.',
    toggleable: true,
    availability: ZOTERO_AVAILABILITY,
  },
  {
    id: 'lean4',
    toolNames: [
      'lean_diagnostics',
      'lean_file',
      'lean_project',
      'lean_inspect',
    ],
    name: 'Lean 4 Proof Assistant',
    category: 'lean',
    description:
      'Interact with Lean 4 projects: check diagnostics, inspect terms, and manage files. Active language servers are listed below. (lean_loogle needs only network access and is always available.)',
    installGuide:
      'TeXRA can drive Lean 4 in two ways:\n\n' +
      '  • VS Code build: uses the "lean4" extension\n' +
      '    (leanprover.lean4) and its running language server.\n' +
      '  • CLI / desktop build: spawns `lake env lean --server`\n' +
      '    directly (one process per Lake project; idle ones stop\n' +
      '    after thirty minutes). Requires `lake` (from elan/Lean) on\n' +
      '    PATH; install via\n' +
      '    https://leanprover-community.github.io/install/.\n\n' +
      'Setup (VS Code):\n' +
      '  1. Install the "lean4" extension from VS Code Marketplace\n' +
      '  2. Open a Lean 4 project (with lakefile.lean or lakefile.toml)\n' +
      '  3. The extension will auto-install elan and Lean toolchain\n\n' +
      'Setup (CLI / desktop):\n' +
      '  1. Install elan: `curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`\n' +
      '  2. Make sure `lake` is on PATH in a fresh shell\n' +
      '  3. Open a folder containing a lakefile.lean / lakefile.toml',
    installUrl:
      'https://marketplace.visualstudio.com/items?itemName=leanprover.lean4',
    installExtensionId: LEAN4_EXTENSION_ID,
    configNotes:
      'VS Code build: requires the leanprover.lean4 extension. ' +
      'CLI / desktop builds: requires `lake` on PATH; each Lake project can have its own language server, and idle ones stop after thirty minutes, surfaced below.',
    availability: LEAN4_AVAILABILITY,
    skills: true,
  },
  {
    id: 'workflow-script',
    toolNames: [DELEGATE_MULTI_AGENTS_TOOL_NAME],
    name: 'Multi-Agent Workflow',
    category: 'workflow',
    description:
      'Run deterministic JavaScript workflow scripts that fan out, pipeline, and join calls to sub-agents, resuming safely after interruption. An agent only gets this tool if its own configuration names it: this switch is an additional kill switch on top of that per-agent opt-in.',
    configNotes:
      'No local install required. Turning this off removes delegate_multi_agents from every agent tool list, even agents whose configuration names it explicitly.',
    toggleable: true,
    availability: ALWAYS_AVAILABLE,
  },
  {
    // ID kept as `github-pr-subscription` for back-compat with persisted
    // disabled-tool preferences. The user-facing name has expanded to
    // cover repos and issues but the persistence key is stable.
    id: 'github-pr-subscription',
    toolNames: ['github_subscription'],
    name: 'GitHub Activity Subscription',
    category: 'ai-agents',
    description:
      'Poll GitHub for pull request, issue, and repository activity. Path mirrors GitHub URL shape: "owner/repo" for coarse repo-wide events, "owner/repo/pulls/N" for per-PR comments/reviews/CI, "owner/repo/issues/N" for issue comments and lifecycle.',
    installGuide:
      'Requires a git-tracked workspace and a GitHub personal access token:\n\n' +
      '  1. Open the folder as a git repo (or `git init` + set a github.com remote).\n' +
      '  2. In the CLI, /config → GitHub token can store a token or open the token page with the right scopes pre-filled. In VS Code, use TeXRA settings → Git tab.\n' +
      '  3. Scopes: "repo" for private repositories, "public_repo" for public only.\n' +
      '  4. Store the token in host secret storage, or export GITHUB_TOKEN/GH_TOKEN for CLI and automation.',
    installUrl: 'https://github.com/settings/tokens',
    configNotes: `Token stored in host secret storage or read from GITHUB_TOKEN/GH_TOKEN. The CLI /config → GitHub token row and the VS Code Git tab both manage the stored token. Requires a git repository in the workspace. Polls every ${GITHUB_POLL_INTERVAL_MS / 1000}s; cap: ${MAX_CONCURRENT_PR_SUBSCRIPTIONS} concurrent PRs and ${MAX_CONCURRENT_REPO_SUBSCRIPTIONS} concurrent repos. Bot-authored events are dropped end-to-end by policy.`,
    authNote: 'Uses personal access token',
    toggleable: true,
    availability: GITHUB_AVAILABILITY,
  },
  {
    id: 'external-inquiry',
    toolNames: ['inquiry'],
    name: 'External Inquiry',
    category: 'ai-agents',
    description:
      'Use premium chat subscriptions such as ChatGPT Pro, Claude Opus, Gemini Deep Think, and Grok without an API key. The agent drafts a question, you paste the answer back, and the run continues. Useful for the deep-reasoning tiers that aren’t available through the API.',
    configNotes:
      'No local install required. Uses your own external chat subscription through a human-in-the-loop copy/paste flow.',
    authNote: 'Uses your premium chat subscription',
    toggleable: true,
    availability: ALWAYS_AVAILABLE,
  },
  {
    id: 'codex',
    toolNames: ['codex'],
    name: 'OpenAI Codex CLI',
    category: 'ai-agents',
    description:
      'OpenAI Codex agent runtime. Required by the Codex SDK for local code generation and analysis.',
    installGuide:
      'Install the Codex CLI (choose one):\n\n' +
      '  npm install -g @openai/codex\n' +
      '  brew install codex          (macOS)\n\n' +
      'On Windows, use WSL or the Codex app.\n' +
      'In WSL, install inside the WSL environment (not on the Windows side).\n' +
      'See: https://developers.openai.com/codex/cli\n\n' +
      'Authentication (choose one):\n' +
      '  • codex login       : sign in with ChatGPT account (recommended)\n' +
      '  • OPENAI_API_KEY    : environment variable with API key',
    installUrl: 'https://github.com/openai/codex',
    get installCommand() {
      return preferredInstallCommand({
        brew: 'brew install codex',
        default: 'npm install -g @openai/codex',
      });
    },
    authCommand: 'codex login',
    configNotes:
      'Requires @openai/codex npm package with platform binaries. Used by @openai/codex-sdk. ' +
      'Supports OAuth via `codex login` or OPENAI_API_KEY env var.',
    authNote: 'Uses ChatGPT subscription (free with Plus/Pro)',
    toggleable: true,
    availability: CODEX_AVAILABILITY,
  },
  {
    // ID kept as `claude-agent` for back-compat with persisted disabled-tool
    // preferences. The user-facing name has been rebranded to "Claude Code CLI"
    // and the tool name string is `claude_code`, but the persistence key is
    // stable.
    id: 'claude-agent',
    toolNames: ['claude_code'],
    name: 'Claude Code CLI',
    category: 'ai-agents',
    description:
      'Spin off a Claude Code CLI agent that works in your workspace. It can read files, run commands, edit code, and search the web on your behalf. Use it to delegate focused exploration or implementation while another agent stays in charge.',
    installGuide:
      'Install the Claude Code CLI (choose one):\n\n' +
      '  npm install -g @anthropic-ai/claude-code\n' +
      '  brew install --cask claude-code     (macOS)\n' +
      '  winget install Anthropic.ClaudeCode (Windows)\n\n' +
      'Or use the native installer from https://claude.com/code (recommended).\n' +
      'See: https://code.claude.com/docs/en/setup\n\n' +
      'Authentication (choose one):\n' +
      '  • Set ANTHROPIC_API_KEY in TeXRA Settings → API Keys → Anthropic\n' +
      '  • claude login         : OAuth sign-in (Pro/Max subscription, recommended)\n' +
      '  • claude setup-token   : long-lived OAuth token (CLAUDE_CODE_OAUTH_TOKEN)\n' +
      '  • ANTHROPIC_API_KEY    : environment variable with Console API key',
    installUrl: 'https://code.claude.com/docs/en/setup',
    get installCommand() {
      return preferredInstallCommand({
        brew: 'brew install --cask claude-code',
        win32: 'winget install Anthropic.ClaudeCode',
        default: 'npm install -g @anthropic-ai/claude-code',
      });
    },
    authCommand: 'claude login',
    configNotes:
      'Requires the native `claude` binary. Supports OAuth (`claude login`), long-lived tokens (`claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN), or ANTHROPIC_API_KEY (resolved from TeXRA Settings → API Keys or the environment).',
    authNote: 'OAuth, OAuth token, or API key',
    toggleable: true,
    availability: CLAUDE_CODE_AVAILABILITY,
  },
  // The system LaTeX and image dependencies are not tool groups: no agent
  // tool is gated on them, and they are surfaced by the LaTeX settings tab
  // (LaTeXTab.ts, SettingsViewMessageHandler.ts) and `texra doctor` instead.
  // Their one catalog — names, per-consumer required/alternative roles, and
  // the doctor's row semantics — is `LATEX_TOOLS` in
  // `@shared/constants/latexToolchain`, which lives in `shared` because the
  // `latex` subsystem reads it too and cannot import `tools`.

  {
    // Tools every host offers without setup that no dashboard card lists:
    // review annotations, the PDF viewer, the user-question dialog, and
    // Loogle search (network only, so not gated on the Lean 4 plugin's probe).
    id: 'core',
    toolNames: [
      'inline_comment',
      'report_review_issue',
      'open_pdf',
      'ask_user_question',
      'lean_loogle',
    ],
    name: 'Core Tools',
    category: 'workflow',
    description:
      'Review annotations, PDF viewing, user questions, and Loogle search.',
    hidden: true,
  },
  {
    // The onboarding agent's narrow set, one responsibility per tool (see the
    // setup imports in `@tools/registry`).
    id: 'setup',
    toolNames: [
      'probe_environment',
      'verify_setup',
      'unset_api_key',
      'list_api_keys',
      'invoke_command',
      'install_vscode_extension',
      'read_config',
      'update_config',
      'send_to_terminal',
      'apply_team',
    ],
    name: 'Setup Assistant',
    category: 'system',
    description:
      'Probe and verify the environment, manage API keys and settings, and apply a team.',
    hidden: true,
  },
] as const satisfies readonly ToolPlugin[];

/**
 * Every tool plugin, in dashboard order. The literal `MANIFEST` type feeds the
 * compile-time checks below and the registry's; consumers read this view.
 */
export const TOOL_PLUGINS: readonly ToolPlugin[] = MANIFEST;

export type ToolPluginEntry = (typeof MANIFEST)[number];

/** Every plugin id in the manifest. */
export type ToolPluginId = ToolPluginEntry['id'];

/** The tool names one plugin (or a union of plugins) declares. */
export type PluginToolName<Id extends ToolPluginId> = Extract<
  ToolPluginEntry,
  { readonly id: Id }
>['toolNames'][number];

/** The first id that repeats in a plugin tuple, or `never`. */
type DuplicateId<
  Plugins extends readonly { readonly id: string }[],
  Seen extends string = never,
> = Plugins extends readonly [
  infer Head extends { readonly id: string },
  ...infer Rest extends readonly { readonly id: string }[],
]
  ? Head['id'] extends Seen
    ? Head['id']
    : DuplicateId<Rest, Seen | Head['id']>
  : never;

type AssertNever<T extends never> = T;
/** Plugin ids are unique. */
type _PluginIdsAreUnique = AssertNever<DuplicateId<typeof MANIFEST>>;

/**
 * A tool name belongs to one plugin. On a clash the error names each plugin
 * id whose tools another plugin also declares.
 */
type AssertNoSharedToolNames<T extends Record<ToolPluginId, never>> = T;
type _ToolNamesAreUniqueAcrossPlugins = AssertNoSharedToolNames<{
  [Id in ToolPluginId]: PluginToolName<Id> &
    PluginToolName<Exclude<ToolPluginId, Id>>;
}>;

/**
 * A toggleable plugin is probed (`ALWAYS_AVAILABLE` when it needs nothing
 * installed), so switching it off withholds its tools; the error names the
 * toggleable plugin ids with no `availability`.
 */
type _ToggleablePluginsAreProbed = AssertNever<
  Exclude<
    Extract<ToolPluginEntry, { readonly toggleable: true }>['id'],
    Extract<ToolPluginEntry, { readonly availability: object }>['id']
  >
>;

/** Look up a plugin by id. */
export function findToolPlugin(id: string): ToolPlugin | undefined {
  return TOOL_PLUGINS.find((plugin) => plugin.id === id);
}
