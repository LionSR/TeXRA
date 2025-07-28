import { TextEditorTool } from './TextEditorTool';
import { DiagnosticsTool } from './DiagnosticsTool';
import { BashTool } from './bash';
import { FileOpTool } from './fileOp';
import { BaseTool } from './core/base';
export const DEFAULT_TOOL_REGISTRY: Record<string, BaseTool<any>> = {
  text_editor: new TextEditorTool(),
  diagnostics: new DiagnosticsTool(),
  bash: new BashTool(),
  file_op: new FileOpTool(),
};
