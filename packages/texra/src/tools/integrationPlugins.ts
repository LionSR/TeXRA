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
} from '@texra/tools/agentCli/agentCliSessionStores';
import { ClaudeAgentTool } from '@texra/tools/agentCli/claudeAgent';
import { CLAUDE_AGENT_NAME } from '@texra/tools/agentCli/claudeAgentShared';
import { CodexTool } from '@texra/tools/agentCli/codex';
import { GitHubSubscriptionTool } from '@texra/tools/github/githubSubscriptionTool';
import { GitHubSubscriptions } from '@texra/tools/github/subscriptionBindings';
import { gitHubSubscriptionsLayer } from '@texra/tools/github/subscriptionRegistries';
import { inquiryRecordsLayer } from '@texra/tools/inquiry/inquiryRecords';
import { ExternalInquiryTool } from '@texra/tools/inquiry/ExternalInquiryTool';
import { recordInquiryDecision } from '@texra/tools/inquiry/inquiryActions';
import {
  LeanDiagnosticsTool,
  LeanFileTool,
  LeanInspectTool,
  LeanProjectTool,
} from '@texra/tools/lean/LspTools';
import { directLeanLanguageServices } from '@texra/tools/lean/direct/directLspAdapter';
import type { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import {
  CLAUDE_CODE_AVAILABILITY,
  CODEX_AVAILABILITY,
  GITHUB_AVAILABILITY,
  lean4Availability,
  WOLFRAM_AVAILABILITY,
  ZOTERO_AVAILABILITY,
} from '@texra/tools/pluginAvailability';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import { ZoteroAddTool } from '@texra/tools/zotero/ZoteroAddTool';
import { ZoteroCollectionsTool } from '@texra/tools/zotero/ZoteroCollectionsTool';
import { ZoteroExportTool } from '@texra/tools/zotero/ZoteroExportTool';
import { ZoteroSearchTool } from '@texra/tools/zotero/ZoteroSearchTool';
import { ALWAYS_AVAILABLE } from '@tools/toolProbes';
import { definePlugin, type Plugin } from '@tools/plugins';
import type { ProcessPluginLayer } from '@tools/toolTable';

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

/**
 * Lean 4 over the direct `lake env lean --server` pool, or over the host's
 * editor bridge in its place; its probe reads the editor extension off the
 * host's setup capabilities.
 */
export const lean4 = (host: {
  readonly setup: SetupPlatformShape;
  readonly services?: ProcessPluginLayer<LeanLanguageServices>['layer'];
}): Plugin =>
  definePlugin<LeanLanguageServices>({
    id: 'lean4',
    tools: {
      lean_diagnostics: LeanDiagnosticsTool,
      lean_file: LeanFileTool,
      lean_project: LeanProjectTool,
      lean_inspect: LeanInspectTool,
    },
    availability: lean4Availability(host.setup),
    processLayer: { layer: host.services ?? directLeanLanguageServices() },
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
  // The answer is recorded on the thread and delivered to the run that
  // asked, before the decision commits.
  decision: {
    kind: 'externalInquiry',
    record: ({ payload, decision, session }) =>
      payload.kind === 'externalInquiry'
        ? recordInquiryDecision(payload.data, decision, session).pipe(
            Effect.provide(inquiryRecordsLayer),
          )
        : Effect.die(
            new Error(`external-inquiry records no ${payload.kind} decision.`),
          ),
  },
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
