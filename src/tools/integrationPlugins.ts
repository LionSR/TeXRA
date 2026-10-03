/**
 * TeXRA's probed integrations: TeXcount, Wolfram, Zotero, Lean 4, GitHub
 * activity, external inquiries and the two agent CLIs. Each is a plugin
 * value of TeXRA's list (`@tools/registry`), with the install and sign-in
 * copy its dashboard card and `texra tools` show.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  ClaudeAgentSessions,
  claudeAgentSessionsLayer,
  CodexThreads,
  codexThreadsLayer,
} from '@tools/agentCliSessionStores';
import { ClaudeAgentTool } from '@tools/claudeAgent';
import { CLAUDE_AGENT_NAME } from '@tools/claudeAgentShared';
import { CodexTool } from '@tools/codex';
import { GitHubSubscriptionTool } from '@tools/github/githubSubscriptionTool';
import {
  GITHUB_POLL_INTERVAL_MS,
  MAX_CONCURRENT_PR_SUBSCRIPTIONS,
  MAX_CONCURRENT_REPO_SUBSCRIPTIONS,
} from '@tools/github/prSubscriptionConstants';
import { GitHubSubscriptions } from '@tools/github/subscriptionBindings';
import { gitHubSubscriptionsLayer } from '@tools/github/subscriptionRegistries';
import { ExternalInquiryTool } from '@tools/inquiry/ExternalInquiryTool';
import {
  LeanDiagnosticsTool,
  LeanFileTool,
  LeanInspectTool,
  LeanProjectTool,
} from '@tools/lean/LspTools';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';
import type { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { LEAN4_EXTENSION_ID } from '@tools/lean/leanTypes';
import {
  CLAUDE_CODE_AVAILABILITY,
  CODEX_AVAILABILITY,
  GITHUB_AVAILABILITY,
  LEAN4_AVAILABILITY,
  TEXCOUNT_AVAILABILITY,
  WOLFRAM_AVAILABILITY,
  ZOTERO_AVAILABILITY,
} from '@tools/pluginAvailability';
import { definePlugin, type Plugin } from '@tools/plugins';
import { TexcountTool } from '@tools/texcount/TexcountTool';
import { ALWAYS_AVAILABLE, preferredInstallCommand } from '@tools/toolProbes';
import { WOLFRAM_INSTALL_GUIDE, WolframTool } from '@tools/wolfram/WolframTool';
import { ZoteroAddTool } from '@tools/zotero/ZoteroAddTool';
import { ZoteroCollectionsTool } from '@tools/zotero/ZoteroCollectionsTool';
import { ZoteroExportTool } from '@tools/zotero/ZoteroExportTool';
import { ZoteroSearchTool } from '@tools/zotero/ZoteroSearchTool';

export const texcount: Plugin = {
  id: 'texcount',
  tools: { texcount: TexcountTool },
  name: 'TeXcount',
  category: 'latex',
  description:
    'Count words, headers, figures, and other elements in LaTeX documents.',
  setup: Object.freeze({
    installGuide:
      'TeXcount is a Perl script for counting words in LaTeX files.\n\n' +
      'Installation:\n' +
      '  Mac:     brew install texcount\n' +
      '  Ubuntu:  sudo apt-get install texlive-extra-utils\n' +
      '  Windows: Install via MiKTeX or TeX Live package manager',
    installUrl: 'https://app.uio.no/ifi/texcount/',
    configNotes: 'Part of most TeX Live distributions.',
  }),
  hidden: true, // Shown in LaTeX settings tab instead
  availability: TEXCOUNT_AVAILABILITY,
};

export const wolfram: Plugin = {
  id: 'wolfram',
  tools: { wolfram: WolframTool },
  name: 'Wolfram Language',
  category: 'computation',
  description:
    'Execute Wolfram Language code for symbolic math, computation, and data analysis.',
  setup: Object.freeze({
    installGuide: WOLFRAM_INSTALL_GUIDE,
    installUrl: 'https://www.wolfram.com/engine/',
    configNotes: 'Requires the free Wolfram Engine (provides wolframscript).',
  }),
  availability: WOLFRAM_AVAILABILITY,
};

export const zotero: Plugin = {
  id: 'zotero',
  tools: {
    zotero_collections: ZoteroCollectionsTool,
    zotero_search: ZoteroSearchTool,
    zotero_add: ZoteroAddTool,
    zotero_export: ZoteroExportTool,
  },
  name: 'Zotero Integration',
  category: 'ai-agents',
  description:
    'Search, add items to, and export citations from your Zotero library. Requires Better BibTeX plugin.',
  setup: Object.freeze({
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
  }),
  toggleable: true,
  availability: ZOTERO_AVAILABILITY,
};

export const lean4 = definePlugin<LeanLanguageServices>({
  id: 'lean4',
  tools: {
    lean_diagnostics: LeanDiagnosticsTool,
    lean_file: LeanFileTool,
    lean_project: LeanProjectTool,
    lean_inspect: LeanInspectTool,
  },
  name: 'Lean 4 Proof Assistant',
  category: 'lean',
  description:
    'Interact with Lean 4 projects: check diagnostics, inspect terms, and manage files. Active language servers are listed below. (lean_loogle needs only network access and is always available.)',
  setup: Object.freeze({
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
  }),
  availability: LEAN4_AVAILABILITY,
  // The direct `lake env lean --server` pool; a host with an editor bridge
  // passes its own (`texraPlugins`).
  processLayer: { layer: directLeanLanguageServices() },
  skills: true,
  agents: true,
});

export const githubActivity = definePlugin<GitHubSubscriptions>({
  // ID kept as `github-pr-subscription` for back-compat with persisted
  // disabled-tool preferences. The user-facing name has expanded to
  // cover repos and issues but the persistence key is stable.
  id: 'github-pr-subscription',
  tools: { github_subscription: GitHubSubscriptionTool },
  name: 'GitHub Activity Subscription',
  category: 'ai-agents',
  description:
    'Poll GitHub for pull request, issue, and repository activity. Path mirrors GitHub URL shape: "owner/repo" for coarse repo-wide events, "owner/repo/pulls/N" for per-PR comments/reviews/CI, "owner/repo/issues/N" for issue comments and lifecycle.',
  setup: Object.freeze({
    installGuide:
      'Requires a git-tracked workspace and a GitHub personal access token:\n\n' +
      '  1. Open the folder as a git repo (or `git init` + set a github.com remote).\n' +
      '  2. In the CLI, /config → GitHub token can store a token or open the token page with the right scopes pre-filled. In VS Code or desktop, use TeXRA Settings → General.\n' +
      '  3. Scopes: "repo" for private repositories, "public_repo" for public only.\n' +
      '  4. Store the token in host secret storage, or export GITHUB_TOKEN/GH_TOKEN for CLI and automation.',
    installUrl: 'https://github.com/settings/tokens',
    configNotes: `Token stored in host secret storage or read from GITHUB_TOKEN/GH_TOKEN. The CLI /config → GitHub token row and Settings → General in VS Code both manage the stored token. Requires a git repository in the workspace. Polls every ${GITHUB_POLL_INTERVAL_MS / 1000}s; cap: ${MAX_CONCURRENT_PR_SUBSCRIPTIONS} concurrent PRs and ${MAX_CONCURRENT_REPO_SUBSCRIPTIONS} concurrent repos. Bot-authored events are dropped end-to-end by policy.`,
    authNote: 'Uses personal access token',
  }),
  toggleable: true,
  processLayer: {
    layer: gitHubSubscriptionsLayer,
    // Its step of the core shutdown protocol.
    drain: Effect.flatMap(GitHubSubscriptions, (s) => s.drainDeliveries),
  },
  availability: GITHUB_AVAILABILITY,
});

export const externalInquiry: Plugin = {
  id: 'external-inquiry',
  tools: { inquiry: ExternalInquiryTool },
  name: 'External Inquiry',
  category: 'ai-agents',
  description:
    'Use premium chat subscriptions such as ChatGPT Pro, Claude Opus, Gemini Deep Think, and Grok without an API key. The agent drafts a question, you paste the answer back, and the run continues. Useful for the deep-reasoning tiers that aren’t available through the API.',
  setup: Object.freeze({
    configNotes:
      'No local install required. Uses your own external chat subscription through a human-in-the-loop copy/paste flow.',
    authNote: 'Uses your premium chat subscription',
  }),
  toggleable: true,
  availability: ALWAYS_AVAILABLE,
};

export const codex = definePlugin<CodexThreads>({
  id: 'codex',
  tools: { codex: CodexTool },
  name: 'OpenAI Codex CLI',
  category: 'ai-agents',
  settings: [
    [WorkspaceStateKey.CODEX_MODEL, 'Model'],
    [WorkspaceStateKey.CODEX_SANDBOX_MODE, 'Sandbox mode'],
    [WorkspaceStateKey.CODEX_REASONING_EFFORT, 'Reasoning effort'],
    [WorkspaceStateKey.CODEX_APPROVAL_POLICY, 'Approval policy'],
  ],
  description:
    'OpenAI Codex agent runtime. Required by the Codex SDK for local code generation and analysis.',
  setup: Object.freeze({
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
  }),
  toggleable: true,
  sessionLayer: codexThreadsLayer,
  availability: CODEX_AVAILABILITY,
});

export const claudeAgent = definePlugin<ClaudeAgentSessions>({
  // ID kept as `claude-agent` for back-compat with persisted disabled-tool
  // preferences. The user-facing name has been rebranded to "Claude Code CLI"
  // and the tool name string is `claude_code`, but the persistence key is
  // stable.
  id: 'claude-agent',
  tools: { [CLAUDE_AGENT_NAME]: ClaudeAgentTool },
  name: 'Claude Code CLI',
  category: 'ai-agents',
  settings: [
    [WorkspaceStateKey.CLAUDE_AGENT_MODEL, 'Model'],
    [WorkspaceStateKey.CLAUDE_AGENT_EFFORT, 'Reasoning effort'],
    [WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE, 'Permission mode'],
  ],
  description:
    'Spin off a Claude Code CLI agent that works in your workspace. It can read files, run commands, edit code, and search the web on your behalf. Use it to delegate focused exploration or implementation while another agent stays in charge.',
  setup: Object.freeze({
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
  }),
  toggleable: true,
  sessionLayer: claudeAgentSessionsLayer,
  availability: CLAUDE_CODE_AVAILABILITY,
});
