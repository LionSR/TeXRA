// Local imports - core types
import type { IToolRegistry } from '@agent/core/ToolTypes';
import { MapToolRegistry } from '@agent/core/ToolTypes';

// Local imports - model types
import {
  ToolDefinitionSchema,
  type ToolDefinition,
} from '@model/ToolDefinition';

// Local imports - tools
import { BashTool } from './bash';
import { DiagnosticsTool } from './DiagnosticsTool';
import { ApplyPathTool } from './applyPath';
import { EditFileTool } from './EditTool';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { LsTool } from './ls';
import {
  ExtractBibliographyTool,
  ExtractLatexFiguresTool,
  ExtractTikzFiguresTool,
  CompileLatexTool,
} from './latex';
import { ExtractCodeStructureTool } from './code';
import { ArxivDownloadTool, ArxivMetadataTool, ArxivSearchTool } from './arxiv';
import { ReadFileTool } from './ReadTool';
import { TextEditorTool } from './TextEditorTool';
import { WriteFileTool } from './WriteTool';
import { WebFetchTool } from './web/WebFetchTool';
import { WebSearchTool } from './web/WebSearchTool';
import { WolframTool } from './wolfram';
import { TexcountTool } from './texcount';
import { CrossrefDoiTool, CrossrefSearchTool } from './citation';
import { TodoWriteTool } from './todo';
import { MemoryTool } from './memory';
import { ZoteroAddTool, ZoteroSearchTool, ZoteroExportTool } from './zotero';
import {
  LeanDiagnosticsTool,
  LeanFileTool,
  LeanProjectTool,
  LeanInspectTool,
  LeanLoogleTool,
} from './lean';
import { WorkflowAgentTool, DelegateAgentTool } from './WorkflowTool';
import { RunsTool } from './RunsTool';

/** Singleton IToolRegistry instance for the default tools. */
let defaultRegistryInstance: IToolRegistry | null = null;

/**
 * Get the default tool registry as an IToolRegistry.
 * Uses lazy initialization and singleton pattern.
 */
export function getDefaultToolRegistry(): IToolRegistry {
  if (!defaultRegistryInstance) {
    defaultRegistryInstance = new MapToolRegistry({
      str_replace_editor: new TextEditorTool(),
      diagnostics: new DiagnosticsTool(),
      bash: new BashTool(),
      read_file: new ReadFileTool(),
      write_file: new WriteFileTool(),
      edit_file: new EditFileTool(),
      apply_path: new ApplyPathTool(),
      glob: new GlobTool(),
      grep: new GrepTool(),
      ls: new LsTool(),
      download_arxiv_source: new ArxivDownloadTool(),
      arxiv_metadata: new ArxivMetadataTool(),
      arxiv_search: new ArxivSearchTool(),
      extract_figures: new ExtractLatexFiguresTool(),
      extract_bib_entries: new ExtractBibliographyTool(),
      extract_tikz_figures: new ExtractTikzFiguresTool(),
      compile_latex: new CompileLatexTool(),
      extract_code_structure: new ExtractCodeStructureTool(),
      crossref_doi: new CrossrefDoiTool(),
      crossref_search: new CrossrefSearchTool(),
      zotero_add: new ZoteroAddTool(),
      zotero_search: new ZoteroSearchTool(),
      zotero_export: new ZoteroExportTool(),
      wolfram: new WolframTool(),
      texcount: new TexcountTool(),
      web_fetch: new WebFetchTool(),
      web_search: new WebSearchTool(),
      todo_write: new TodoWriteTool(),
      memory: new MemoryTool(),
      // Lean 4 tools (uses VS Code extension)
      lean_diagnostics: new LeanDiagnosticsTool(),
      lean_file: new LeanFileTool(),
      lean_project: new LeanProjectTool(),
      lean_inspect: new LeanInspectTool(),
      lean_loogle: new LeanLoogleTool(),
      propose_workflow: new WorkflowAgentTool(),
      propose_agent: new DelegateAgentTool(),
      runs: new RunsTool(),
    });
  }
  return defaultRegistryInstance;
}

/**
 * Reset the default tool registry singleton.
 * @internal For testing only - prevents state leakage between tests.
 */
export function resetDefaultToolRegistry(): void {
  defaultRegistryInstance = null;
}

/**
 * Valid tool name pattern: starts with letter/underscore, followed by alphanumeric/underscores.
 */
const VALID_TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates a tool name contains only allowed characters.
 * @returns true if valid, false otherwise
 */
function isValidToolName(name: string): boolean {
  return VALID_TOOL_NAME_PATTERN.test(name);
}

/**
 * Raw tool configuration from YAML - can be a string name or partial definition.
 * Object form must have a name and can include optional description/parameters.
 */
export type RawToolConfig =
  | string
  | (Partial<ToolDefinition> & { name: string });

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

    if (!isValidToolName(name)) {
      warnOnMissing?.(name);
      return { name };
    }

    const tool = registry.get(name);
    if (!tool) {
      warnOnMissing?.(name);
    }

    // String items: return tool definition or minimal fallback
    if (typeof item === 'string') {
      return tool?.definition ?? { name };
    }

    // Object items: always parse with schema to validate/merge overrides
    return ToolDefinitionSchema.catch({ name }).parse(item);
  });
}
