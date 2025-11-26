/**
 * @file result.ts
 *
 * Re-exports tool result types from the consolidated source in @agent/core/ToolTypes.
 * This file is kept for backward compatibility with existing imports.
 *
 * @see @agent/core/ToolTypes for the single source of truth.
 */
export {
  type DiagnosticsPayload,
  type ErrorDiagnostics,
  ToolError,
  type ToolFileAttachment,
  type ToolResult,
  toolResult,
} from '@agent/core/ToolTypes';

/** @deprecated Use toolResult instead. */
export { toolResult as cliResult } from '@agent/core/ToolTypes';
