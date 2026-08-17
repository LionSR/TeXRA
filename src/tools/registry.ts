// Third-party imports
import stableStringify from 'fast-json-stable-stringify';

// Local imports
import type {
  ITool,
  IToolRegistry,
  ToolHost,
} from '@agent/core/tools/ToolTypes';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ToolDefinition } from '@model/ToolDefinition';
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
import {
  ProbeEnvironmentTool,
  VerifySetupTool,
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
let defaultToolsInstance: ReturnType<typeof createDefaultTools> | null = null;

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

function getDefaultTools(): ReturnType<typeof createDefaultTools> {
  defaultToolsInstance ??= createDefaultTools();
  return defaultToolsInstance;
}

/** Union of all tool names registered in the default registry. */
export type RegisteredToolName = keyof ReturnType<typeof createDefaultTools>;

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
  if (!defaultRegistryInstance) {
    defaultRegistryInstance = new MapToolRegistry(getDefaultTools());
  }
  return defaultRegistryInstance;
}

/** Derive a host's static exclusions from the tools that own those capabilities. */
export function getDefaultUnavailableToolNames(
  host: ToolHost,
): readonly RegisteredToolName[] {
  return Object.entries(getDefaultTools()).flatMap(([name, tool]) =>
    tool.hosts?.[host]?.available === false ? [name as RegisteredToolName] : [],
  );
}

/** Whether a registered tool declares itself unavailable on a product host. */
export function isDefaultToolUnavailableOnHost(
  name: RegisteredToolName,
  host: ToolHost,
): boolean {
  return getDefaultTools()[name].hosts?.[host]?.available === false;
}

/** Valid tool name pattern: starts with letter/underscore, followed by alphanumeric/underscores. */
const VALID_TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * A declared tool: a registry name, or a whole definition — either one a parent
 * agent's load already resolved, or one an embedder registered as a value, the
 * only way to attach the runtime-only fields no YAML can express.
 */
type RawToolConfig = string | ToolDefinition;

function differsFrom(declared: unknown, registered: unknown): boolean {
  if (declared === undefined || declared === registered) return false;
  return stableStringify(declared) !== stableStringify(registered);
}

/**
 * Whether an entry states a contract of its own instead of the registered one.
 * An inherited entry carries the definition a parent's load already resolved,
 * so repeating the registry's own description and parameters is not an override.
 */
function overridesContract(
  item: RawToolConfig,
  registered: ToolDefinition,
): boolean {
  if (typeof item === 'string') return false;
  return (
    differsFrom(item.description, registered.description) ||
    differsFrom(item.parameters, registered.parameters)
  );
}

/**
 * Resolve declared tools to their definitions. A registered tool's contract is
 * the registered one: a definition entry that names it contributes only that
 * name, and any description or parameters it carries are dropped with a warning
 * rather than handed to the model in place of the real contract.
 *
 * @param tools - Declared tool names or definitions
 * @param warnOnMissing - Optional callback for logging warnings. `reason` says
 *   what happened to the entry, so a dropped override is never reported as a
 *   missing tool.
 * @returns Array of resolved ToolDefinition objects
 */
export function resolveToolDefinitions(
  tools: RawToolConfig[],
  warnOnMissing?: (toolName: string, reason: string) => void,
): ToolDefinition[] {
  const registry = getDefaultToolRegistry();
  const seenNames = new Set<string>();

  return tools.flatMap((item): ToolDefinition[] => {
    const name = typeof item === 'string' ? item : item.name;
    if (seenNames.has(name)) {
      return [];
    }
    seenNames.add(name);

    const tool = VALID_TOOL_NAME.test(name) ? registry.get(name) : undefined;

    // Unregistered name: keep an embedder's own definition, and fall back to a
    // bare name for everything else so the entry is still visible downstream.
    if (!tool) {
      warnOnMissing?.(name, 'not found in registry');
      return [typeof item === 'string' ? { name } : item];
    }

    if (overridesContract(item, tool.definition)) {
      warnOnMissing?.(
        name,
        'is declared with a description or parameters; agent definitions name tools, so the registered definition is used instead',
      );
    }
    return [tool.definition];
  });
}
