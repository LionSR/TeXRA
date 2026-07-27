// Local imports
import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import {
  ToolDefinitionSchema,
  type ToolDefinition,
} from '@model/ToolDefinition';
import type { CanonicalToolDisplayName } from '@shared/tools/toolKind';
import {
  DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
  type CanonicalDelegationToolName,
} from '@shared/constants/delegationTools';

// Local file imports — core tools (no domain-subsystem imports)
import { BashTool } from './bash';
import { DiagnosticsTool } from './DiagnosticsTool';
import { InlineCommentTool } from './comment/InlineCommentTool';
import { ReportReviewIssueTool } from './ReportReviewIssueTool';
import { EditFileTool } from './EditTool';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { ReadFileTool } from './ReadTool';
import { TextEditorTool } from './TextEditorTool';
import { WriteFileTool } from './WriteTool';
import { WebFetchTool } from './web/WebFetchTool';
import { WebSearchTool } from './web/WebSearchTool';
import { TodoWriteTool } from './todo/TodoTool';
import { MemoryTool } from './memory/MemoryTool';
import { CodexTool } from './codex';
import { ClaudeAgentTool } from './claudeAgent';
import { CLAUDE_AGENT_NAME } from './claudeAgentShared';
import { WorkflowAgentTool, DelegateAgentTool } from './DelegationTools';
import { WorkflowScriptTool } from './delegation/WorkflowScriptTool';
import { ExecutionsTool } from './ExecutionsTool';
import { ExternalInquiryTool } from './inquiry';
import { AskUserQuestionTool } from './userQuestion';
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

// Domain-tool names — kept in sync with registry-domain.ts's createDomainTools().
// Defined here as a string literal union rather than imported from registry-domain
// to avoid TypeScript resolving the full domain-tool module graph to compute the
// `keyof ReturnType<typeof createDomainTools>` type (#9327).
type DomainToolName =
  | 'download_arxiv_source'
  | 'arxiv_metadata'
  | 'arxiv_search'
  | 'extract_figures'
  | 'extract_bib_entries'
  | 'extract_tikz_figures'
  | 'crossref_search'
  | 'zotero_add'
  | 'zotero_collections'
  | 'zotero_search'
  | 'zotero_export'
  | 'wolfram'
  | 'texcount'
  | 'lean_diagnostics'
  | 'lean_file'
  | 'lean_project'
  | 'lean_inspect'
  | 'lean_loogle'
  | 'github_subscription'
  | 'plan'
  | 'open_pdf'
  | 'accept_run_files';

// ============================================================================
// Registry
// ============================================================================

/** Singleton IToolRegistry instance for the default tools. */
let defaultRegistryInstance: IToolRegistry | null = null;

/** Whether domain tools have been loaded into the default registry. */
let domainToolsRegistered = false;

/**
 * Core-tool factory — tools whose transitive imports do not include
 * `@latex/`, `src/tools/lean/`, `src/tools/arxiv/`, or `src/tools/zotero/`.
 *
 * Domain tools live in {@link createDomainTools} (`./registry-domain`)
 * and are loaded lazily through {@link ensureDomainToolsRegistered}.
 */
function createCoreTools() {
  return {
    str_replace_editor: new TextEditorTool(),
    diagnostics: new DiagnosticsTool(),
    inline_comment: new InlineCommentTool(),
    report_review_issue: new ReportReviewIssueTool(),
    bash: new BashTool(),
    read_file: new ReadFileTool(),
    write_file: new WriteFileTool(),
    edit_file: new EditFileTool(),
    glob: new GlobTool(),
    grep: new GrepTool(),
    web_fetch: new WebFetchTool(),
    web_search: new WebSearchTool(),
    todo_write: new TodoWriteTool(),
    memory: new MemoryTool(),
    codex: new CodexTool(),
    [CLAUDE_AGENT_NAME]: new ClaudeAgentTool(),
    delegate_workflow: new WorkflowAgentTool(),
    [DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME]: new WorkflowScriptTool(),
    delegate_agent: new DelegateAgentTool(),
    executions: new ExecutionsTool(),
    inquiry: new ExternalInquiryTool(),
    ask_user_question: new AskUserQuestionTool(),
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

/** Canonical tool names from core tools. */
type CoreToolName = keyof ReturnType<typeof createCoreTools>;

/**
 * Union of every tool name registered in the default registry —
 * core (eager) + domain (lazy). `DomainToolName` is a type-only import
 * so the bundle graph does not include domain-tool modules.
 */
export type RegisteredToolName = CoreToolName | DomainToolName;

/**
 * Compile-time guard: every canonical tool with specialized display treatment
 * must remain registered. The shared module excludes its documented native
 * text-editor alias before exporting `CanonicalToolDisplayName`.
 */
type AssertNever<T extends never> = T;
type _CanonicalDisplayNamesAreRegistered = AssertNever<
  Exclude<CanonicalToolDisplayName, RegisteredToolName>
>;

/** Compile-time guard for canonical delegation names; historical aliases are excluded. */
type _CanonicalDelegationNamesAreRegistered = AssertNever<
  Exclude<CanonicalDelegationToolName, RegisteredToolName>
>;

// ============================================================================
// Domain-tool lazy registration
// ============================================================================

/**
 * Dynamically import domain tools and merge them into the default registry.
 * Idempotent — subsequent calls are no-ops.
 *
 * Domain tools are those whose module graphs pull in `@latex/`, `src/tools/lean/`,
 * `src/tools/arxiv/`, or `src/tools/zotero/`. Keeping them out of the eager
 * module body breaks the import cycle described in #9327, shrinking every
 * generic tool's transitive closure from ~630 files to ~150 files.
 */
export async function ensureDomainToolsRegistered(): Promise<void> {
  if (domainToolsRegistered) return;
  const { createDomainTools } = await import('./registry-domain');
  const coreTools = createCoreTools();
  const domainTools = createDomainTools();
  defaultRegistryInstance = new MapToolRegistry({
    ...coreTools,
    ...domainTools,
  });
  domainToolsRegistered = true;
}

// ============================================================================
// Public API
// ============================================================================

/** Lazy singleton accessor for the default tool registry. */
export function getDefaultToolRegistry(): IToolRegistry {
  if (!defaultRegistryInstance) {
    defaultRegistryInstance = new MapToolRegistry(createCoreTools());
  }
  return defaultRegistryInstance;
}

/**
 * Legacy tool-name aliases — keep prior YAML configs working when a tool is
 * renamed. Each entry maps `<old name> → <canonical name>`. Aliases are
 * normalized while loading configs, rather than registered as extra tool names,
 * so the model sees only the canonical definition.
 */
const TOOL_ALIASES: Record<string, RegisteredToolName> = {
  add_criticism: 'diagnostics',
  // Remove on 2026-08-19 after the custom-agent migration window; see #6981.
  crossref_doi: 'crossref_search',
  external_inquiry: 'inquiry',
};

function canonicalToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
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
 * Domain tools are loaded lazily on first call — the dynamic import of
 * `./registry-domain` is a code-splitting point that breaks the cycle
 * described in #9327, keeping domain subsystems out of generic tools'
 * transitive closures.
 *
 * @param tools - Array of raw tool configs (strings or objects with name)
 * @param warnOnMissing - Optional callback for logging warnings about missing/invalid tools
 * @returns Array of resolved ToolDefinition objects
 */
export async function resolveToolDefinitions(
  tools: RawToolConfig[],
  warnOnMissing?: (toolName: string) => void,
): Promise<ToolDefinition[]> {
  await ensureDomainToolsRegistered();

  const registry = getDefaultToolRegistry();
  const seenNames = new Set<string>();

  return tools.flatMap((item): ToolDefinition[] => {
    const name = typeof item === 'string' ? item : item.name;
    const canonicalName = canonicalToolName(name);
    if (seenNames.has(canonicalName)) {
      return [];
    }
    seenNames.add(canonicalName);

    if (!VALID_TOOL_NAME.test(canonicalName)) {
      warnOnMissing?.(name);
      return [{ name: canonicalName }];
    }

    const tool = registry.get(canonicalName);
    if (!tool) {
      warnOnMissing?.(name);
    }

    // Aliases are compatibility names, not independent tool contracts. Legacy
    // object-form configs may carry the retired tool's parameter schema, so
    // normalize the whole definition at this boundary instead of only renaming
    // it and exposing a stale contract to the model.
    if (name !== canonicalName && tool) {
      return [tool.definition];
    }

    // String items: return tool definition or minimal fallback
    if (typeof item === 'string') {
      return [tool?.definition ?? { name: canonicalName }];
    }

    // Object items: always parse with schema to validate/merge overrides
    return [
      ToolDefinitionSchema.catch({ name: canonicalName }).parse({
        ...item,
        name: canonicalName,
      }),
    ];
  });
}
