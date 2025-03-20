/**
 * Type definitions for Anthropic API related interfaces
 */

/**
 * Union type for tool parameters in Anthropic API
 */
export type BetaToolUnionParam = {
  name: string;
  type: string;
};

/**
 * Type for the text editor tool parameters
 */
export interface TextEditorToolParams extends BetaToolUnionParam {
  name: 'str_replace_editor';
  type: 'text_editor_20250124' | 'text_editor_20241022';
}

/**
 * Command types for the text editor tool
 */
export type EditorCommand =
  | 'view'
  | 'create'
  | 'str_replace'
  | 'insert'
  | 'undo_edit';

/**
 * Interface for the tool call input
 */
export interface ToolCallInput {
  command: EditorCommand;
  path: string;
  file_text?: string;
  view_range?: [number, number];
  old_str?: string;
  new_str?: string;
  insert_line?: number;
}

/**
 * Interface for file history entries
 */
export interface FileHistoryEntry {
  path: string;
  content: string;
}
