// Local imports - tools
import { BashTool } from './bash';
import { BaseTool } from './core/base';
import { DiagnosticsTool } from './DiagnosticsTool';
import { FileOpTool } from './fileOp';
import { TextEditorTool } from './TextEditorTool';
import { WebSearchTool } from './web/WebSearchTool';
import { WolframTool } from './wolfram';

export const DEFAULT_TOOL_REGISTRY: Record<string, BaseTool<any>> = {
  str_replace_editor: new TextEditorTool(),
  diagnostics: new DiagnosticsTool(),
  bash: new BashTool(),
  file_op: new FileOpTool(),
  wolfram: new WolframTool(),
  web_search: new WebSearchTool(),
};
