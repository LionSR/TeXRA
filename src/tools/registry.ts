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
    diagnostics: new DiagnosticsTool(),
    inline_comment: new InlineCommentTool(),
    report_review_issue: new ReportReviewIssueTool(),
    bash: new BashTool(),
    read_file: new ReadFileTool(),
    write_file: new WriteFileTool(),
    edit_file: new EditFileTool(),
    glob: new GlobTool(),
    grep: new GrepTool(),
    download_arxiv_source: new ArxivDownloadTool(),
    arxiv_metadata: new ArxivMetadataTool(),
    arxiv_search: new ArxivSearchTool(),
    extract_figures: new ExtractLatexFiguresTool(),
    extract_bib_entries: new ExtractBibliographyTool(),
    extract_tikz_figures: new ExtractTikzFiguresTool(),
    crossref_search: new CrossrefSearchTool(),
    zotero_add: new ZoteroAddTool(),
    zotero_collections: new ZoteroCollectionsTool(),
    zotero_search: new ZoteroSearchTool(),
    zotero_export: new ZoteroExportTool(),
    wolfram: new WolframTool(),
    texcount: new TexcountTool(),
    web_fetch: new WebFetchTool(),
    web_search: new WebSearchTool(),
    todo_write: new TodoWriteTool(),
    plan: new PlanTool(),
    memory: new MemoryTool(),
    open_pdf: new OpenPdfTool(),
    lean_diagnostics: new LeanDiagnosticsTool(),
    lean_file: new LeanFileTool(),
    lean_project: new LeanProjectTool(),
    lean_inspect: new LeanInspectTool(),
    lean_loogle: new LeanLoogleTool(),
    codex: new CodexTool(),
    [CLAUDE_AGENT_NAME]: new ClaudeAgentTool(),
    delegate_workflow: new WorkflowAgentTool(),
    [DELEGATE_MULTI_AGENTS_TOOL_NAME]: new WorkflowScriptTool(),
    delegate_agent: new DelegateAgentTool(),
    executions: new ExecutionsTool(),
    accept_run_files: new AcceptRunFilesTool(),
    inquiry: new ExternalInquiryTool(),
    ask_user_question: new AskUserQuestionTool(),
    github_subscription: new GitHubSubscriptionTool(),
    probe_environment: new ProbeEnvironmentTool(),
    verify_setup: new VerifySetupTool(),
    unset_api_key: new UnsetApiKeyTool(),
    list_api_keys: new ListApiKeysTool(),
    invoke_command: new InvokeCommandTool(),
    install_vscode_extension: new InstallVscodeExtensionTool(),
    read_config: new ReadConfigTool(),
    update_config: new UpdateConfigTool(),
    send_to_terminal: new SendToTerminalTool(),
    apply_team: new ApplyTeamTool(),
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

/** Derive a host's static exclusions from the tools that own those capabilities. */
export function getDefaultUnavailableToolNames(
  host: ToolHost,
): readonly RegisteredToolName[] {
  return (Object.keys(getDefaultTools()) as RegisteredToolName[]).filter(
    (name) => isDefaultToolUnavailableOnHost(name, host),
  );
}

/** Whether a registered tool declares itself unavailable on a product host. */
export function isDefaultToolUnavailableOnHost(
  name: RegisteredToolName,
  host: ToolHost,
): boolean {
  return getDefaultTools()[name].unavailableHosts?.includes(host) === true;
}
