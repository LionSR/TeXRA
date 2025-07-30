import { TextEditorTool } from './TextEditorTool';
import { DiagnosticsTool } from './DiagnosticsTool';
import { BashTool } from './bash';
import { FileOpTool } from './fileOp';
import { WolframTool } from './wolfram';
import { WebSearchTool } from './web/WebSearchTool';

import { BaseTool } from './core/base';
export const DEFAULT_TOOL_REGISTRY: Record<string, BaseTool<any>> = {
  str_replace_editor: new TextEditorTool(),
  diagnostics: new DiagnosticsTool(),
  bash: new BashTool(),
  file_op: new FileOpTool(),
  wolfram: new WolframTool(),
  web_search: new WebSearchTool(),
};
