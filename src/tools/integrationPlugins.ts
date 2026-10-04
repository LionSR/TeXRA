/**
 * TeXRA's probed integrations: Wolfram, Zotero, Lean 4, GitHub
 * activity, external inquiries and the two agent CLIs. Each is a plugin
 * value of TeXRA's list (`@tools/registry`); the install and sign-in copy
 * its dashboard card and `texra tools` show is its card (`@tools/pluginCards`).
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
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
import {
  CLAUDE_CODE_AVAILABILITY,
  CODEX_AVAILABILITY,
  GITHUB_AVAILABILITY,
  LEAN4_AVAILABILITY,
  WOLFRAM_AVAILABILITY,
  ZOTERO_AVAILABILITY,
} from '@tools/pluginAvailability';
import { definePlugin, type Plugin } from '@tools/plugins';
import { ALWAYS_AVAILABLE } from '@tools/toolProbes';
import { ZoteroAddTool } from '@tools/zotero/ZoteroAddTool';
import { ZoteroCollectionsTool } from '@tools/zotero/ZoteroCollectionsTool';
import { ZoteroExportTool } from '@tools/zotero/ZoteroExportTool';
import { ZoteroSearchTool } from '@tools/zotero/ZoteroSearchTool';

/** A probe without tools: agents run `wolframscript` through `bash`. */
export const wolfram: Plugin = {
  id: 'wolfram',
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
  toggle: 'off',
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
  availability: LEAN4_AVAILABILITY,
  // The direct `lake env lean --server` pool; a host with an editor bridge
  // passes its own (`texraPlugins`).
  processLayer: { layer: directLeanLanguageServices() },
});

export const githubActivity = definePlugin<GitHubSubscriptions>({
  // ID kept as `github-pr-subscription` for back-compat with persisted
  // disabled-tool preferences. The user-facing name has expanded to
  // cover repos and issues but the persistence key is stable.
  id: 'github-pr-subscription',
  tools: { github_subscription: GitHubSubscriptionTool },
  toggle: 'off',
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
  toggle: 'off',
  availability: ALWAYS_AVAILABLE,
};

export const codex = definePlugin<CodexThreads>({
  id: 'codex',
  tools: { codex: CodexTool },
  toggle: 'off',
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
  toggle: 'off',
  sessionLayer: claudeAgentSessionsLayer,
  availability: CLAUDE_CODE_AVAILABILITY,
});
