import type { ToolDefinition } from '@model';

export const ToolSets: Record<string, ToolDefinition[]> = {
  file_edit: [{ name: 'text_editor' }],
  diagnostics_only: [{ name: 'diagnostics' }],
  basic_io: [{ name: 'bash' }, { name: 'file_op' }],
  wolframExec: [{ name: 'wolfram' }],
};
