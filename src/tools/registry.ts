// Local imports - core types
import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';

// Local imports - model types
import {
  ToolDefinitionSchema,
  type ToolDefinition,
} from '@model/ToolDefinition';

// Local imports - shared tools
import type { CanonicalToolDisplayName } from '@shared/tools/toolKind';

// Local imports - tools
import { BashTool } from './bash';
import { DiagnosticsTool } from './DiagnosticsTool';
import { InlineCommentTool } from './comment/InlineCommentTool';
import { ReportReviewIssueTool } from './ReportReviewIssueTool';
import { ApplyPathTool } from './applyPath';
import { EditFileTool } from './EditTool';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import {
  ExtractBibliographyTool,
  ExtractLatexFiguresTool,
  ExtractTikzFiguresTool,
} from './latex';
import { ArxivDownloadTool } from './arxiv/ArxivDownloadTool';
import { ArxivMetadataTool } from './arxiv/ArxivMetadataTool';
import { ArxivSearchTool } from './arxiv/ArxivSearchTool';
import { ReadFileTool } from './ReadTool';
import { TextEditorTool } from './TextEditorTool';
import { WriteFileTool } from './WriteTool';
import { WebFetchTool } from './web/WebFetchTool';
import { WebSearchTool } from './web/WebSearchTool';
import { WolframTool } from './wolfram/WolframTool';
import { TexcountTool } from './texcount/TexcountTool';
import { CrossrefDoiTool } from './citation/CrossrefDoiTool';
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
  LeanLoogleTool,
} from './lean';
import { WorkflowAgentTool, DelegateAgentTool } from './DelegationTools';
import { ExecutionsTool } from './ExecutionsTool';
import { AcceptRunFilesTool } from './AcceptRunFilesTool';
import { ExternalInquiryTool } from './inquiry';
import { AskUserQuestionTool } from './userQuestion';
import { GitHubSubscriptionTool } from './github';
import {
  ProbeEnvironmentTool,
  VerifySetupTool,
  SetApiKeyTool,
  UnsetApiKeyTool,
  ListApiKeysTool,
  InvokeCommandTool,
  InstallVscodeExtensionTool,
  ReadConfigTool,
  UpdateConfigTool,
  SendToTerminalTool,
  ApplyTeamTool,
} from './setup';

/** Singleton IToolRegistry instance for the default tools. */
let defaultRegistryInstance: IToolRegistry | null = null;

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
    str_replace_editor: new TextEditorTool(),
    diagnostics: new DiagnosticsTool(),
    inline_comment: new InlineCommentTool(),
    report_review_issue: new ReportReviewIssueTool(),
    bash: new BashTool(),
    read_file: new ReadFileTool(),
    write_file: new WriteFileTool(),
    edit_file: new EditFileTool(),
    apply_path: new ApplyPathTool(),
    glob: new GlobTool(),
    grep: new GrepTool(),
    download_arxiv_source: new ArxivDownloadTool(),
    arxiv_metadata: new ArxivMetadataTool(),
    arxiv_search: new ArxivSearchTool(),
    extract_figures: new ExtractLatexFiguresTool(),
    extract_bib_entries: new ExtractBibliographyTool(),
    extract_tikz_figures: new ExtractTikzFiguresTool(),
    crossref_doi: new CrossrefDoiTool(),
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
    delegate_agent: new DelegateAgentTool(),
    executions: new ExecutionsTool(),
    accept_run_files: new AcceptRunFilesTool(),
    inquiry: new ExternalInquiryTool(),
    ask_user_question: new AskUserQuestionTool(),
    github_subscription: new GitHubSubscriptionTool(),
    probe_environment: new ProbeEnvironmentTool(),
    verify_setup: new VerifySetupTool(),
    set_api_key: new SetApiKeyTool(),
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

/** Union of all tool names registered in the default registry. */
export type RegisteredToolName = keyof ReturnType<typeof createDefaultTools>;

/**
 * Compile-time guard: every canonical tool with specialized display treatment
 * must remain registered. The shared module excludes its documented native
 * text-editor alias before exporting `CanonicalToolDisplayName`.
 */
type AssertNever<T extends never> = T;
type _CanonicalDisplayNamesAreRegistered = AssertNever<
  Exclude<CanonicalToolDisplayName, RegisteredToolName>
>;

/**
 * Legacy tool-name aliases — keep prior YAML configs working when a tool is
 * renamed. Each entry maps `<old name> → <canonical name>`. Aliases are
 * normalized while loading configs, rather than registered as extra tool names,
 * so the model sees only the canonical definition.
 */
const TOOL_ALIASES: Record<string, string> = {
  add_criticism: 'diagnostics',
  external_inquiry: 'inquiry',
};

function canonicalToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

/** Lazy singleton accessor for the default tool registry. */
export function getDefaultToolRegistry(): IToolRegistry {
  if (!defaultRegistryInstance) {
    defaultRegistryInstance = new MapToolRegistry(createDefaultTools());
  }
  return defaultRegistryInstance;
}

/** Valid tool name pattern: starts with letter/underscore, followed by alphanumeric/underscores. */
const VALID_TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Raw tool configuration from YAML - can be a string name or partial definition.
 * Object form must have a name and can include optional description/parameters.
 */
export type RawToolConfig =
  string | (Partial<ToolDefinition> & { name: string });

/**
 * Resolve raw tool configurations to ToolDefinition objects.
 * Handles both string names (resolved from registry) and partial definitions.
 *
 * @param tools - Array of raw tool configs (strings or objects with name)
 * @param warnOnMissing - Optional callback for logging warnings about missing/invalid tools
 * @returns Array of resolved ToolDefinition objects
 */
export function resolveToolDefinitions(
  tools: RawToolConfig[],
  warnOnMissing?: (toolName: string) => void,
): ToolDefinition[] {
  const registry = getDefaultToolRegistry();

  return tools.map((item): ToolDefinition => {
    const name = typeof item === 'string' ? item : item.name;
    const canonicalName = canonicalToolName(name);

    if (!VALID_TOOL_NAME.test(canonicalName)) {
      warnOnMissing?.(name);
      return { name: canonicalName };
    }

    const tool = registry.get(canonicalName);
    if (!tool) {
      warnOnMissing?.(name);
    }

    // String items: return tool definition or minimal fallback
    if (typeof item === 'string') {
      return tool?.definition ?? { name: canonicalName };
    }

    // Object items: always parse with schema to validate/merge overrides
    return ToolDefinitionSchema.catch({ name: canonicalName }).parse({
      ...item,
      name: canonicalName,
    });
  });
}
