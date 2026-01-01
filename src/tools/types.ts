/**
 * Type definitions for Anthropic API related interfaces
 */

/**
 * Union type for tool parameters in Anthropic API
 */
export interface BetaToolUnionParam {
  name: string;
  type: string;
  description?: string;
  input_schema?: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

/**
 * Type for the text editor tool parameters
 */
export interface TextEditorToolParams extends BetaToolUnionParam {
  name: 'str_replace_editor' | 'str_replace_based_edit_tool';
  type:
    | 'text_editor_20250124'
    | 'text_editor_20241022'
    | 'text_editor_20250429';
}

// Re-export schema-derived types from TextEditorTool (single source of truth)
export { EditorCommand, TextEditorInput } from './TextEditorTool';

/**
 * Interface for file history entries
 */
export interface FileHistoryEntry {
  path: string;
  content: string;
}

/**
 * Base error interface with common properties
 */
export interface BaseError {
  message: string;
  line?: number;
}

/**
 * Extended error interface with additional properties for XML validation errors
 */
export interface XMLValidationError extends BaseError {
  code?: string;
  data?: any;
}

/**
 * Standard validation result interface for all agents
 */
export interface ValidationResult<T extends BaseError | BaseError[]> {
  isValid: boolean;
  error?: T;
}
