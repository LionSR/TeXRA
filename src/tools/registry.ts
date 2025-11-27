// Local imports - core types
import type { ITool, IToolRegistry } from '@agent/core/ToolTypes';
import { createToolRegistry } from '@agent/core/ToolTypes';

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
import { WebFetchTool } from './web/WebFetchTool';
import { WebSearchTool } from './web/WebSearchTool';
import { WolframTool } from './wolfram';
import { TexcountTool } from './texcount';
import { CrossrefDoiTool, CrossrefSearchTool } from './citation';

/**
 * Default tool instances as a plain Record.
 * @deprecated Use getDefaultToolRegistry() for IToolRegistry interface.
 */
const DEFAULT_TOOLS: Record<string, ITool> = {
  str_replace_editor: new TextEditorTool(),
  diagnostics: new DiagnosticsTool(),
  bash: new BashTool(),
  read_file: new ReadFileTool(),
  write_file: new WriteFileTool(),
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
};

/** Singleton IToolRegistry instance for the default tools. */
let defaultRegistryInstance: IToolRegistry | null = null;

/**
 * Get the default tool registry as an IToolRegistry.
 * Uses lazy initialization and singleton pattern.
 */
export function getDefaultToolRegistry(): IToolRegistry {
  if (!defaultRegistryInstance) {
    defaultRegistryInstance = createToolRegistry(DEFAULT_TOOLS);
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
 * Default tool registry as a Record.
 * @deprecated Prefer getDefaultToolRegistry() for IToolRegistry interface.
 */
export const DEFAULT_TOOL_REGISTRY: Record<string, ITool> = DEFAULT_TOOLS;
