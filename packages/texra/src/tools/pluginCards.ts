/**
 * TeXRA's Tools dashboard cards: how the app shows each plugin it lists
 * there, keyed by plugin id, in dashboard order. The plugin value
 * (`@tools/plugins`) says what a plugin contributes to a run; this record
 * is the app's copy beside it, which the settings view's Plugins page and
 * `texra tools` read. A plugin with no card is listed on no dashboard.
 */

// Local imports
import type {
  PluginSettingRow,
  SettingHost,
} from '@shared/state/stateSettings';
import type { ToolCategory } from '@shared/tools/toolPlugin';
import {
  CLAUDE_AGENT_SETTINGS,
  CODEX_SETTINGS,
} from '@texra/shared/settingsView/integrationSettings';
import {
  GITHUB_POLL_INTERVAL_MS,
  MAX_CONCURRENT_PR_SUBSCRIPTIONS,
  MAX_CONCURRENT_REPO_SUBSCRIPTIONS,
} from '@texra/tools/github/prSubscriptionConstants';
import { LEAN4_EXTENSION_ID } from '@texra/tools/lean/leanTypes';
import { preferredInstallCommand } from '@texra/tools/availabilityProbes';

/** How a user gets a probed plugin's dependency installed and signed in. */
export interface ToolPluginSetup {
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

/** One plugin's dashboard card. */
export interface PluginCard {
  /** The plugin's id (`Plugin.id`). */
  readonly id: string;
  readonly name: string;
  readonly category: ToolCategory;
  readonly description: string;
  /** Product hosts whose dashboard does not list the plugin. */
  readonly unavailableHosts?: readonly SettingHost[];
  /** The plugin's catalog rows the card renders inline, in order; the
   *  catalog itself takes them from TeXRA's rows (`@shared/settingsView/texraSettings`). */
  readonly settings?: readonly PluginSettingRow[];
  /** Install and sign-in copy and actions; only a probed plugin's card
   *  shows them. */
  readonly setup?: ToolPluginSetup;
}

/** TeXRA's cards, in dashboard order. */
export const TEXRA_PLUGIN_CARDS: readonly PluginCard[] = [
  {
    id: 'file-ops',
    name: 'File & Shell Operations',
    category: 'file',
    description:
      'Read, write, edit files and run shell commands. Includes glob/grep search.',
  },
  {
    id: 'latex-extract',
    name: 'LaTeX Extraction',
    category: 'latex',
    description:
      'Extract figures, TikZ diagrams, and bibliography entries from LaTeX documents.',
  },
  {
    id: 'latex-diagnostics',
    name: 'LaTeX Diagnostics',
    category: 'latex',
    description:
      'Report LaTeX compilation errors and warnings from the VS Code Problems panel.',
  },
  {
    id: 'arxiv',
    name: 'ArXiv Search & Download',
    category: 'academic',
    description: 'Search arXiv papers and download LaTeX source packages.',
  },
  {
    id: 'web',
    name: 'Web Search & Fetch',
    category: 'web',
    description:
      'Search the web with DuckDuckGo Instant Answers and fetch or extract content from URLs.',
  },
  {
    id: 'memory-workflow',
    name: 'Memory & Executions',
    category: 'workflow',
    description:
      'Persistent memory across sessions and the executions view of the runs an agent launched.',
  },
  {
    id: 'goal',
    name: 'Goal Mode',
    category: 'workflow',
    description:
      'Propose a plan for approval and, when you run it as a goal, let the agent keep working turn after turn until the objective is done or it needs you.',
    setup: {
      configNotes:
        "No local install required. Turning this off removes the plan tool from every agent and stops goal turns, from each run's next step.",
    },
  },
  {
    id: 'wolfram',
    name: 'Wolfram Language',
    category: 'computation',
    description:
      'Wolfram Language through wolframscript, which agents run from the shell for symbolic math, computation, and data analysis.',
    setup: {
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
    },
  },
  {
    id: 'zotero',
    name: 'Zotero Integration',
    category: 'ai-agents',
    description:
      'Search, add items to, and export citations from your Zotero library. Requires Better BibTeX plugin.',
    setup: {
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
    },
  },
  {
    id: 'lean4',
    name: 'Lean 4 Proof Assistant',
    category: 'lean',
    description:
      'Interact with Lean 4 projects: check diagnostics, inspect terms, and manage files. Active language servers are listed below. (lean_loogle needs only network access and is always available.)',
    setup: {
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
    },
  },
  {
    id: 'multi-agent',
    name: 'Multi-Agent Workflow',
    category: 'workflow',
    description:
      'Run named agents as children of a run: one at a time, or fanned out and joined from a script, resuming safely after interruption. An agent only gets the agent tool if its own configuration names it: this switch is an additional kill switch on top of that per-agent opt-in.',
    setup: {
      configNotes:
        'No local install required. Turning this off removes the agent tool from every agent tool list, even agents whose configuration names it explicitly, so no agent can delegate.',
    },
  },
  {
    id: 'github-pr-subscription',
    name: 'GitHub Activity Subscription',
    category: 'ai-agents',
    description:
      'Poll GitHub for pull request, issue, and repository activity. Path mirrors GitHub URL shape: "owner/repo" for coarse repo-wide events, "owner/repo/pulls/N" for per-PR comments/reviews/CI, "owner/repo/issues/N" for issue comments and lifecycle.',
    setup: {
      installGuide:
        'Requires a git-tracked workspace and a GitHub personal access token:\n\n' +
        '  1. Open the folder as a git repo (or `git init` + set a github.com remote).\n' +
        '  2. In the CLI, /config → GitHub token can store a token or open the token page with the right scopes pre-filled. In VS Code or desktop, use TeXRA Settings → General.\n' +
        '  3. Scopes: "repo" for private repositories, "public_repo" for public only.\n' +
        '  4. Store the token in host secret storage, or export GITHUB_TOKEN/GH_TOKEN for CLI and automation.',
      installUrl: 'https://github.com/settings/tokens',
      configNotes: `Token stored in host secret storage or read from GITHUB_TOKEN/GH_TOKEN. The CLI /config → GitHub token row and Settings → General in VS Code both manage the stored token. Requires a git repository in the workspace. Polls every ${GITHUB_POLL_INTERVAL_MS / 1000}s; cap: ${MAX_CONCURRENT_PR_SUBSCRIPTIONS} concurrent PRs and ${MAX_CONCURRENT_REPO_SUBSCRIPTIONS} concurrent repos. Bot-authored events are dropped end-to-end by policy.`,
      authNote: 'Uses personal access token',
    },
  },
  {
    id: 'external-inquiry',
    name: 'External Inquiry',
    category: 'ai-agents',
    description:
      'Use premium chat subscriptions such as ChatGPT Pro, Claude Opus, Gemini Deep Think, and Grok without an API key. The agent drafts a question, you paste the answer back, and the run continues. Useful for the deep-reasoning tiers that aren’t available through the API.',
    setup: {
      configNotes:
        'No local install required. Uses your own external chat subscription through a human-in-the-loop copy/paste flow.',
      authNote: 'Uses your premium chat subscription',
    },
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    category: 'ai-agents',
    description:
      'OpenAI Codex agent runtime. Required by the Codex SDK for local code generation and analysis.',
    settings: CODEX_SETTINGS,
    setup: {
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
      get installCommand(): string {
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
    },
  },
  {
    id: 'claude-agent',
    name: 'Claude Code CLI',
    category: 'ai-agents',
    description:
      'Spin off a Claude Code CLI agent that works in your workspace. It can read files, run commands, edit code, and search the web on your behalf. Use it to delegate focused exploration or implementation while another agent stays in charge.',
    settings: CLAUDE_AGENT_SETTINGS,
    setup: {
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
      get installCommand(): string {
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
    },
  },
  {
    id: 'copilot',
    name: 'Copilot Chat Tools',
    category: 'ai-agents',
    description:
      'Expose arXiv search and web fetch to GitHub Copilot Chat and agent mode as #texra_arxiv_search and #texra_web_fetch. Each is exposed while its own plugin is on.',
    unavailableHosts: ['cli', 'desktop', 'sdk'],
    setup: {
      configNotes:
        'VS Code only. Turning this off removes every TeXRA tool from Copilot.',
    },
  },
];
