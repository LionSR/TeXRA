// Local imports - tools
import { BashTool } from './bash';
import { BaseTool } from './core/base';
import { DiagnosticsTool } from './DiagnosticsTool';
import { EditFileTool } from './EditTool';
import { FileOpTool } from './fileOp';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { LsTool } from './ls';
import { ReadFileTool } from './ReadTool';
import { TextEditorTool } from './TextEditorTool';
import { WriteFileTool } from './WriteTool';
import { WebFetchTool } from './web/WebFetchTool';
import { WebSearchTool } from './web/WebSearchTool';
import { WolframTool } from './wolfram';
import { ExtractFiguresTool } from './latex/ExtractFiguresTool';
import { ExtractTikzFiguresTool } from './latex/ExtractTikzFiguresTool';

export const DEFAULT_TOOL_REGISTRY: Record<string, BaseTool<any>> = {
  str_replace_editor: new TextEditorTool(),
  diagnostics: new DiagnosticsTool(),
  bash: new BashTool(),
  read_file: new ReadFileTool(),
  write_file: new WriteFileTool(),
  edit_file: new EditFileTool(),
  file_op: new FileOpTool(),
  glob: new GlobTool(),
  grep: new GrepTool(),
  ls: new LsTool(),
  wolfram: new WolframTool(),
  web_fetch: new WebFetchTool(),
  web_search: new WebSearchTool(),
  extract_figures: new ExtractFiguresTool(),
  extract_tikz_figures: new ExtractTikzFiguresTool(),
};
