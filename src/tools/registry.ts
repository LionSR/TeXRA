// Local imports - core types
import type { IToolRegistry } from '@agent/core/ToolTypes';
import { createToolRegistry } from '@agent/core/ToolTypes';

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
import { FileOpTool } from './fileOp';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { LsTool } from './ls';
import {
  ExtractBibliographyTool,
  ExtractLatexFiguresTool,
  ExtractTikzFiguresTool,
} from './latex';
import { ArxivDownloadTool, ArxivMetadataTool, ArxivSearchTool } from './arxiv';
import { ReadFileTool } from './ReadTool';
import { TextEditorTool } from './TextEditorTool';
import { WriteFileTool } from './WriteTool';
import { MemoryTool } from './MemoryTool';
import { WebFetchTool } from './web/WebFetchTool';
import { WebSearchTool } from './web/WebSearchTool';
import { WolframTool } from './wolfram';
import { TexcountTool } from './texcount';
import { CrossrefDoiTool, CrossrefSearchTool } from './citation';
import { TodoWriteTool } from './todo';

/** Singleton IToolRegistry instance for the default tools. */
let defaultRegistryInstance: IToolRegistry | null = null;

/**
 * Get the default tool registry as an IToolRegistry.
 * Uses lazy initialization and singleton pattern.
 */
export function getDefaultToolRegistry(): IToolRegistry {
  if (!defaultRegistryInstance) {
    defaultRegistryInstance = createToolRegistry({
      str_replace_editor: new TextEditorTool(),
      diagnostics: new DiagnosticsTool(),
      bash: new BashTool(),
      read_file: new ReadFileTool(),
      write_file: new WriteFileTool(),
      memory: new MemoryTool(),
      edit_file: new EditFileTool(),
      file_op: new FileOpTool(),
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
      crossref_doi: new CrossrefDoiTool(),
      crossref_search: new CrossrefSearchTool(),
      wolfram: new WolframTool(),
      texcount: new TexcountTool(),
      web_fetch: new WebFetchTool(),
      web_search: new WebSearchTool(),
      todo_write: new TodoWriteTool(),
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
  return tools.map((item): ToolDefinition => {
    if (typeof item === 'string') {
      // Validate tool name format - warn but preserve original name for debugging
      if (!isValidToolName(item)) {
        warnOnMissing?.(item);
        return { name: item };
      }
      const registry = getDefaultToolRegistry();
      const tool = registry.get(item);
      if (!tool) {
        warnOnMissing?.(item);
        return { name: item };
      }
      return tool.definition;
    }
    // Validate tool name format for object form - warn but preserve original name
    if (!isValidToolName(item.name)) {
      warnOnMissing?.(item.name);
      return { name: item.name };
    }
    const registry = getDefaultToolRegistry();
    if (!registry.get(item.name)) {
      warnOnMissing?.(item.name);
    }
    // Parse with fallback to minimal definition if validation fails
    return ToolDefinitionSchema.catch({ name: item.name }).parse(item);
  });
}
