/**
 * The tool plugin manifest data: one entry per plugin, in dashboard order.
 * `@tools/plugins` declares the entry shape, checks this list at compile time
 * and is the module every consumer reads; this file only holds the data.
 */

// Local imports
import { DELEGATE_MULTI_AGENTS_TOOL_NAME } from '@shared/constants/delegationTools';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
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
import { preferredInstallCommand } from '@tools/toolProbes';
import type { ToolPlugin } from '@tools/plugins';

/** How to get `wolframscript`: the Wolfram card's guide, and the Wolfram
 *  tool's answer when the command is missing. */
export const WOLFRAM_INSTALL_GUIDE =
  'Requires the "wolframscript" command-line tool.\n\n' +
  'Install the free Wolfram Engine:\n' +
  '  Mac:     brew install --cask wolfram-engine\n' +
  '  Ubuntu:  Download from wolfram.com/engine\n' +
  '  Windows: Download from wolfram.com/engine\n\n' +
  'Note: A Mathematica installation alone is not enough: you\n' +
  'need WolframScript on your PATH. The Wolfram Engine includes\n' +
  'it automatically. Free licenses are available for development use.';

export const MANIFEST = [
  {
    id: 'file-ops',
    toolNames: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
    name: 'File & Shell Operations',
    category: 'file',
    keywords: ['file', 'edit', 'code', 'write', 'read', 'script', 'shell'],
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
    keywords: ['latex', 'figure', 'tikz', 'bibliography', 'bib', 'extract'],
    description:
      'Extract figures, TikZ diagrams, and bibliography entries from LaTeX documents.',
  },
  {
    id: 'latex-diagnostics',
    toolNames: ['diagnostics'],
    name: 'LaTeX Diagnostics',
    category: 'latex',
    keywords: ['diagnostic', 'compile'],
    description:
      'Report LaTeX compilation errors and warnings from the VS Code Problems panel.',
  },
  {
    id: 'arxiv',
    toolNames: ['arxiv_search', 'arxiv_metadata', 'download_arxiv_source'],
    name: 'ArXiv Search & Download',
    category: 'academic',
    keywords: ['arxiv', 'paper', 'research', 'literature', 'review', 'survey'],
    description:
      'Search arXiv papers, retrieve metadata, and download LaTeX source packages.',
  },
  {
    id: 'crossref',
    toolNames: ['crossref_search'],
    name: 'Crossref Citation Lookup',
    category: 'academic',
    keywords: [
      'crossref',
      'paper',
      'research',
      'literature',
      'cite',
      'doi',
      'journal',
    ],
    description:
      'Search Crossref for academic publications by query or resolve DOIs to full metadata.',
  },
  {
    id: 'web',
    toolNames: ['web_search', 'web_fetch'],
    name: 'Web Search & Fetch',
    category: 'web',
    keywords: ['web', 'search', 'internet', 'online', 'url', 'fetch', 'browse'],
    description:
      'Search the web with DuckDuckGo Instant Answers and fetch or extract content from URLs.',
  },
  {
    id: 'memory-workflow',
    toolNames: [
      'memory',
      'todo_write',
      'delegate_workflow',
      'delegate_agent',
      'executions',
      'accept_run_files',
    ],
    injectedWhen: { memory: GlobalStateKey.MEMORY_ENABLED },
    name: 'Memory, Tasks & Delegation',
    category: 'workflow',
    keywords: [
      'memory',
      'todo',
      'track',
      'delegate',
      'orchestrat',
      'pipeline',
      'multi-agent',
      'chain',
    ],
    description:
      'Persistent memory across sessions, task tracking with to-do lists, and delegate work to sub-agents.',
  },
  {
    // The `plan` tool owns planning and the goal lifecycle (update, pause,
    // complete), so any tool-use agent can drive the goal loop while the
    // plugin is on; the synthetic turns are its continuation policy.
    id: 'goal',
    toolNames: ['plan'],
    injectedWhen: { plan: true },
    name: 'Goal Mode',
    category: 'workflow',
    keywords: ['plan', 'goal', 'autonomous', 'objective'],
    description:
      'Propose a plan for approval and, when you run it as a goal, let the agent keep working turn after turn until the objective is done or it needs you.',
    configNotes:
      'No local install required. Turning this off removes the plan tool from every agent, and runs started afterwards open no goal turns.',
    toggleable: true,
    onByDefault: true,
    availability: ALWAYS_AVAILABLE,
    continuation: true,
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
    keywords: [
      'math',
      'compute',
      'calculate',
      'wolfram',
      'symbolic',
      'equation',
    ],
    description:
      'Execute Wolfram Language code for symbolic math, computation, and data analysis.',
    installGuide: WOLFRAM_INSTALL_GUIDE,
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
    keywords: ['zotero', 'citation', 'reference', 'bibliography', 'endnote'],
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
    keywords: ['lean', 'proof', 'theorem', 'formal', 'verification'],
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
    agents: true,
  },
  {
    id: 'workflow-script',
    toolNames: [DELEGATE_MULTI_AGENTS_TOOL_NAME],
    name: 'Multi-Agent Workflow',
    category: 'workflow',
    keywords: ['orchestrat', 'pipeline', 'multi-agent', 'fan out', 'parallel'],
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
    keywords: ['github', 'pull request'],
    description:
      'Poll GitHub for pull request, issue, and repository activity. Path mirrors GitHub URL shape: "owner/repo" for coarse repo-wide events, "owner/repo/pulls/N" for per-PR comments/reviews/CI, "owner/repo/issues/N" for issue comments and lifecycle.',
    installGuide:
      'Requires a git-tracked workspace and a GitHub personal access token:\n\n' +
      '  1. Open the folder as a git repo (or `git init` + set a github.com remote).\n' +
      '  2. In the CLI, /config → GitHub token can store a token or open the token page with the right scopes pre-filled. In VS Code or desktop, use TeXRA Settings → General.\n' +
      '  3. Scopes: "repo" for private repositories, "public_repo" for public only.\n' +
      '  4. Store the token in host secret storage, or export GITHUB_TOKEN/GH_TOKEN for CLI and automation.',
    installUrl: 'https://github.com/settings/tokens',
    configNotes: `Token stored in host secret storage or read from GITHUB_TOKEN/GH_TOKEN. The CLI /config → GitHub token row and Settings → General in VS Code both manage the stored token. Requires a git repository in the workspace. Polls every ${GITHUB_POLL_INTERVAL_MS / 1000}s; cap: ${MAX_CONCURRENT_PR_SUBSCRIPTIONS} concurrent PRs and ${MAX_CONCURRENT_REPO_SUBSCRIPTIONS} concurrent repos. Bot-authored events are dropped end-to-end by policy.`,
    authNote: 'Uses personal access token',
    toggleable: true,
    availability: GITHUB_AVAILABILITY,
  },
  {
    id: 'external-inquiry',
    toolNames: ['inquiry'],
    name: 'External Inquiry',
    category: 'ai-agents',
    keywords: ['second opinion', 'chatgpt', 'gemini', 'grok', 'deep think'],
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
    keywords: ['codex'],
    settings: [
      [WorkspaceStateKey.CODEX_SANDBOX_MODE, 'Sandbox mode'],
      [WorkspaceStateKey.CODEX_REASONING_EFFORT, 'Reasoning effort'],
      [WorkspaceStateKey.CODEX_APPROVAL_POLICY, 'Approval policy'],
    ],
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
    keywords: ['claude code'],
    settings: [
      [WorkspaceStateKey.CLAUDE_AGENT_MODEL, 'Model'],
      [WorkspaceStateKey.CLAUDE_AGENT_EFFORT, 'Reasoning effort'],
      [WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE, 'Permission mode'],
    ],
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
