// Local imports
import { MapToolRegistry, type ToolHost } from '@agent/core/tools/ToolTypes';
import type {
  RuntimeTool as ITool,
  RuntimeToolRegistry as IToolRegistry,
} from '@agent/runtime/ToolServices';
import type { CanonicalToolDisplayName } from '@shared/tools/toolKind';
import {
  DELEGATE_MULTI_AGENTS_TOOL_NAME,
  type CanonicalDelegationToolName,
} from '@shared/constants/delegationTools';

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

/** Singleton IToolRegistry instance for the default tools. */
let defaultRegistryInstance: IToolRegistry | null = null;
let defaultToolsInstance: DefaultTools | null = null;

/**
 * Canonical tool factory — single source of truth for all registered tools.
 * `RegisteredToolName` is derived from the return-type keys, so adding/renaming
 * a tool here automatically propagates to the dashboard and availability
 * checks at compile time.
 *
 * Defined as a function (not a module-scope const) so tool constructors
 * run lazily on first `getDefaultToolRegistry()` call rather than eagerly
 * on import. This keeps imports side-effect-free.
 */
function createDefaultTools() {
  return {
    diagnostics: DiagnosticsTool,
    inline_comment: InlineCommentTool,
    report_review_issue: ReportReviewIssueTool,
    bash: BashTool,
    read_file: ReadFileTool,
    write_file: WriteFileTool,
    edit_file: EditFileTool,
    glob: GlobTool,
    grep: GrepTool,
    download_arxiv_source: ArxivDownloadTool,
    arxiv_metadata: ArxivMetadataTool,
    arxiv_search: ArxivSearchTool,
    extract_figures: ExtractLatexFiguresTool,
    extract_bib_entries: ExtractBibliographyTool,
    extract_tikz_figures: ExtractTikzFiguresTool,
    crossref_search: CrossrefSearchTool,
    zotero_add: ZoteroAddTool,
    zotero_collections: ZoteroCollectionsTool,
    zotero_search: ZoteroSearchTool,
    zotero_export: ZoteroExportTool,
    wolfram: WolframTool,
    texcount: TexcountTool,
    web_fetch: WebFetchTool,
    web_search: WebSearchTool,
    todo_write: TodoWriteTool,
    plan: PlanTool,
    memory: MemoryTool,
    open_pdf: OpenPdfTool,
    lean_diagnostics: LeanDiagnosticsTool,
    lean_file: LeanFileTool,
    lean_project: LeanProjectTool,
    lean_inspect: LeanInspectTool,
    lean_loogle: LeanLoogleTool,
    codex: CodexTool,
    [CLAUDE_AGENT_NAME]: ClaudeAgentTool,
    delegate_workflow: WorkflowAgentTool,
    [DELEGATE_MULTI_AGENTS_TOOL_NAME]: WorkflowScriptTool,
    delegate_agent: DelegateAgentTool,
    executions: ExecutionsTool,
    accept_run_files: AcceptRunFilesTool,
    inquiry: ExternalInquiryTool,
    ask_user_question: AskUserQuestionTool,
    github_subscription: GitHubSubscriptionTool,
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
  } satisfies Record<string, ITool>;
}

type DefaultTools = ReturnType<typeof createDefaultTools>;

function getDefaultTools(): DefaultTools {
  defaultToolsInstance ??= createDefaultTools();
  return defaultToolsInstance;
}

/** Union of all tool names registered in the default registry. */
export type RegisteredToolName = keyof DefaultTools;

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

/** Lazy singleton accessor for the default tool registry. */
export function getDefaultToolRegistry(): IToolRegistry {
  defaultRegistryInstance ??= new MapToolRegistry(getDefaultTools());
  return defaultRegistryInstance;
}

/** Whether a registered tool declares itself unavailable on a product host. */
export function isDefaultToolUnavailableOnHost(
  name: RegisteredToolName,
  host: ToolHost,
): boolean {
  return getDefaultTools()[name].unavailableHosts?.includes(host) === true;
}
