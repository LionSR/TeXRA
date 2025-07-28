import { TextEditorTool } from './TextEditorTool';
import { DiagnosticsTool } from './DiagnosticsTool';
import { BashTool } from './bash';
import { FileOpTool } from './fileOp';
export const DEFAULT_TOOL_REGISTRY: Record<string, any> = {
  text_editor: new TextEditorTool(),
  diagnostics: new DiagnosticsTool(),
  bash: new BashTool(),
  file_op: new FileOpTool(),
};
