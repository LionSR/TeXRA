// Third-party imports
import { Layer } from 'effect';

// Local imports
import type { ToolHost } from '@agent/core/tools/ToolTypes';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import type { CanonicalToolDisplayName } from '@shared/tools/toolKind';
import {
  DELEGATE_MULTI_AGENTS_TOOL_NAME,
  type CanonicalDelegationToolName,
} from '@shared/constants/delegationTools';
import { toolTableLayer } from '@tools/compositions';
import type {
  PluginToolName,
  ToolPluginEntry,
  ToolPluginId,
} from '@tools/plugins';
import { toolTable, type PluginLayer } from '@tools/toolTable';

// Local file imports
import { BashTool } from './bash';
import { DiagnosticsTool } from './DiagnosticsTool';
import { InlineCommentTool } from './comment/InlineCommentTool';
import { ReportReviewIssueTool } from './ReportReviewIssueTool';
import { EditFileTool } from './EditTool';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { ExtractBibliographyTool } from './latex/ExtractBibliographyTool';
import { ExtractLatexFiguresTool } from './latex/ExtractFiguresTool';
import { ExtractTikzFiguresTool } from './latex/ExtractTikzFiguresTool';
import { ArxivDownloadTool } from './arxiv/ArxivDownloadTool';
import { ArxivMetadataTool } from './arxiv/ArxivMetadataTool';
import { ArxivSearchTool } from './arxiv/ArxivSearchTool';
import { ReadFileTool } from './ReadTool';
import { WriteFileTool } from './WriteTool';
import { WebFetchTool } from './web/WebFetchTool';
import { WebSearchTool } from './web/WebSearchTool';
import { WolframTool } from './wolfram/WolframTool';
import { TexcountTool } from './texcount/TexcountTool';
import { CrossrefSearchTool } from './citation/CrossrefSearchTool';
import { PlanTool } from './plan/PlanTool';
import { TodoWriteTool } from './todo/TodoTool';
import { MemoryTool } from './memory/MemoryTool';
import { OpenPdfTool } from './OpenPdfTool';
import { ZoteroAddTool } from './zotero/ZoteroAddTool';
import { ZoteroCollectionsTool } from './zotero/ZoteroCollectionsTool';
import { ZoteroExportTool } from './zotero/ZoteroExportTool';
import { ZoteroSearchTool } from './zotero/ZoteroSearchTool';
import { CodexTool } from './codex';
import { ClaudeAgentTool } from './claudeAgent';
import { CLAUDE_AGENT_NAME } from './claudeAgentShared';
import {
  LeanDiagnosticsTool,
  LeanFileTool,
  LeanProjectTool,
  LeanInspectTool,
} from './lean/LspTools';
import { LeanLoogleTool } from './lean/LoogleTool';
import {
  WorkflowAgentTool,
  DelegateAgentTool,
} from './delegation/DelegationTools';
import { WorkflowScriptTool } from './delegation/WorkflowScriptTool';
import { ExecutionsTool } from './ExecutionsTool';
import { AcceptRunFilesTool } from './AcceptRunFilesTool';
import { ExternalInquiryTool } from './inquiry/ExternalInquiryTool';
import { AskUserQuestionTool } from './userQuestion/UserQuestionTool';
import { GitHubSubscriptionTool } from './github/githubSubscriptionTool';
/**
 * Setup-assistant tools: a narrow UNIX-style set for the onboarding agent.
 *
 * Each tool has one responsibility:
 *   - probe_environment — read-only environment snapshot
 *   - verify_setup — re-check dependencies
 *   - unset_api_key — remove a persisted provider credential
 *   - list_api_keys — enumerate stored secret key names for auditing
 *   - invoke_command — bridge to allowlisted VS Code commands
 *   - install_vscode_extension — install LaTeX Workshop / Lean 4
 *   - read_config / update_config — read a TeXRA setting, or write an
 *     allowlisted one
 *   - send_to_terminal — type into VS Code's integrated terminal for
 *     sudo / interactive prompts the captured-stdio bash tool can't handle
 *   - apply_team — apply a discipline roster + record the default team
 *
 * Shell-rc writes go through the regular `bash` tool (and its approval
 * dialog) — there's no dedicated rc-writing tool. A hand-rolled validator
 * on top of shell would be a second, weaker approval surface that every
 * reviewer keeps finding bypasses for.
 *
 * Credentials come from the `Secrets` service and the host-varying
 * capabilities from the `SetupPlatform` service, both provided by the host's
 * composition root through `installProcessRuntime`.
 */
import { ProbeEnvironmentTool } from './setup/ProbeEnvironmentTool';
import { VerifySetupTool } from './setup/VerifySetupTool';
import { UnsetApiKeyTool } from './setup/UnsetApiKeyTool';
import { ListApiKeysTool } from './setup/ListApiKeysTool';
import { InvokeCommandTool } from './setup/InvokeCommandTool';
import { InstallVscodeExtensionTool } from './setup/InstallVscodeExtensionTool';
import { ReadConfigTool, UpdateConfigTool } from './setup/ConfigTools';
import { SendToTerminalTool } from './setup/SendToTerminalTool';
import { ApplyTeamTool } from './setup/ApplyTeamTool';

/**
 * Every plugin's tool objects, keyed by plugin id then tool name. The
 * `satisfies` clause is the manifest check: each plugin in `TOOL_PLUGINS` must
 * appear here with exactly the tools its `toolNames` declares — a missing or
 * extra name, or an unknown plugin id, is a compile error.
 */
const PLUGIN_TOOLS = {
  'file-ops': {
    bash: BashTool,
    read_file: ReadFileTool,
    write_file: WriteFileTool,
    edit_file: EditFileTool,
    glob: GlobTool,
    grep: GrepTool,
  },
  'latex-extract': {
    extract_figures: ExtractLatexFiguresTool,
    extract_tikz_figures: ExtractTikzFiguresTool,
    extract_bib_entries: ExtractBibliographyTool,
  },
  'latex-diagnostics': { diagnostics: DiagnosticsTool },
  arxiv: {
    arxiv_search: ArxivSearchTool,
    arxiv_metadata: ArxivMetadataTool,
    download_arxiv_source: ArxivDownloadTool,
  },
  crossref: { crossref_search: CrossrefSearchTool },
  web: { web_search: WebSearchTool, web_fetch: WebFetchTool },
  'memory-workflow': {
    memory: MemoryTool,
    todo_write: TodoWriteTool,
    plan: PlanTool,
    delegate_workflow: WorkflowAgentTool,
    delegate_agent: DelegateAgentTool,
    executions: ExecutionsTool,
    accept_run_files: AcceptRunFilesTool,
  },
  texcount: { texcount: TexcountTool },
  wolfram: { wolfram: WolframTool },
  zotero: {
    zotero_collections: ZoteroCollectionsTool,
    zotero_search: ZoteroSearchTool,
    zotero_add: ZoteroAddTool,
    zotero_export: ZoteroExportTool,
  },
  lean4: {
    lean_diagnostics: LeanDiagnosticsTool,
    lean_file: LeanFileTool,
    lean_project: LeanProjectTool,
    lean_inspect: LeanInspectTool,
  },
  'workflow-script': { [DELEGATE_MULTI_AGENTS_TOOL_NAME]: WorkflowScriptTool },
  'github-pr-subscription': { github_subscription: GitHubSubscriptionTool },
  'external-inquiry': { inquiry: ExternalInquiryTool },
  codex: { codex: CodexTool },
  'claude-agent': { [CLAUDE_AGENT_NAME]: ClaudeAgentTool },
  core: {
    inline_comment: InlineCommentTool,
    report_review_issue: ReportReviewIssueTool,
    open_pdf: OpenPdfTool,
    ask_user_question: AskUserQuestionTool,
    lean_loogle: LeanLoogleTool,
  },
  setup: {
    probe_environment: ProbeEnvironmentTool,
    verify_setup: VerifySetupTool,
    unset_api_key: UnsetApiKeyTool,
    list_api_keys: ListApiKeysTool,
    invoke_command: InvokeCommandTool,
    install_vscode_extension: InstallVscodeExtensionTool,
    read_config: ReadConfigTool,
    update_config: UpdateConfigTool,
    send_to_terminal: SendToTerminalTool,
    apply_team: ApplyTeamTool,
  },
} as const satisfies {
  readonly [Id in ToolPluginId]: {
    readonly [Name in PluginToolName<Id>]: ITool;
  };
};

/**
 * The layer of each plugin that owns resources, keyed by plugin id: exactly
 * the plugins whose manifest entry declares `layer`. Each is one object for
 * the life of the process, so the compositions that include its plugin
 * share one build of it.
 */
const PLUGIN_LAYERS = {} as const satisfies {
  readonly [
    Id in Extract<ToolPluginEntry, { readonly layer: true }>['id']
  ]: PluginLayer;
};

type PluginTools = typeof PLUGIN_TOOLS;

/** Union of all registered tool names. */
export type RegisteredToolName = {
  [Id in ToolPluginId]: keyof PluginTools[Id];
}[ToolPluginId];

/**
 * Compile-time guard: every canonical tool with specialized display treatment
 * must remain registered.
 */
type AssertNever<T extends never> = T;
type _CanonicalDisplayNamesAreRegistered = AssertNever<
  Exclude<CanonicalToolDisplayName, RegisteredToolName>
>;

/** Compile-time guard for canonical delegation names; historical aliases are excluded. */
type _CanonicalDelegationNamesAreRegistered = AssertNever<
  Exclude<CanonicalDelegationToolName, RegisteredToolName>
>;

/**
 * Every plugin's tools, for readers outside a run (the Tools dashboard, the
 * VS Code language-model tools); a run reads the same table as the
 * `ToolRegistry` service. Flattening cannot overwrite a tool: the manifest
 * rules out a name two plugins share.
 */
export const TOOL_TABLE = toolTable(PLUGIN_TOOLS, PLUGIN_LAYERS);

/**
 * The process's `ToolRegistry` and the `Compositions` built over it, which
 * `installProcessRuntime` provides.
 */
export const toolRegistryLayer = toolTableLayer(TOOL_TABLE);

/** Whether a registered tool declares itself unavailable on a product host. */
export function isToolUnavailableOnHost(name: string, host: ToolHost): boolean {
  return TOOL_TABLE.get(name)?.unavailableHosts?.includes(host) === true;
}
