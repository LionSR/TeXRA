// Local imports - tools
import { BashTool } from './bash';
import { BaseTool } from './core/base';
import { DiagnosticsTool } from './DiagnosticsTool';
import { FileOpTool } from './fileOp';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { LsTool } from './ls';
import { TextEditorTool } from './TextEditorTool';
import { WebFetchTool } from './web/WebFetchTool';
import { WebSearchTool } from './web/WebSearchTool';
import { WolframTool } from './wolfram';

export const DEFAULT_TOOL_REGISTRY: Record<string, BaseTool<any>> = {
  str_replace_editor: new TextEditorTool(),
  diagnostics: new DiagnosticsTool(),
  bash: new BashTool(),
  file_op: new FileOpTool(),
  glob: new GlobTool(),
  grep: new GrepTool(),
  ls: new LsTool(),
  wolfram: new WolframTool(),
  web_fetch: new WebFetchTool(),
  web_search: new WebSearchTool(),
};
