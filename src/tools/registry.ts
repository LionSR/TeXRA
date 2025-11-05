// Local imports - tools
import { BashTool } from './bash';
import { BaseTool } from './core/base';
import { DiagnosticsTool } from './DiagnosticsTool';
import { ApplyPathTool } from './applyPath';
import { EditFileTool } from './EditTool';
import { FileOpTool } from './fileOp';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { LsTool } from './ls';
import {
  ArxivDownloadTool,
  ExtractLatexFiguresTool,
  ExtractTikzFiguresTool,
} from './latex';
import { ReadFileTool } from './ReadTool';
import { TextEditorTool } from './TextEditorTool';
import { WriteFileTool } from './WriteTool';
import { WebFetchTool } from './web/WebFetchTool';
import { WebSearchTool } from './web/WebSearchTool';
import { WolframTool } from './wolfram';
import { TexcountTool } from './texcount';
import {
  DoiLookupTool,
  ArxivMetadataTool,
  AddToBibliographyTool,
  ManageBibliographyTool,
} from './papers';

export const DEFAULT_TOOL_REGISTRY: Record<string, BaseTool<any>> = {
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
  extract_figures: new ExtractLatexFiguresTool(),
  extract_tikz_figures: new ExtractTikzFiguresTool(),
  wolfram: new WolframTool(),
  texcount: new TexcountTool(),
  web_fetch: new WebFetchTool(),
  web_search: new WebSearchTool(),
  doi_lookup: new DoiLookupTool(),
  arxiv_metadata: new ArxivMetadataTool(),
  add_to_bibliography: new AddToBibliographyTool(),
  manage_bibliography: new ManageBibliographyTool(),
};
