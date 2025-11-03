import type { Diagnostic } from 'vscode';
import type { ZodIssue } from 'zod';

export interface DiagnosticsPayload {
  path: string;
  command: 'list' | 'count';
  severity: Record<string, number>;
  messages?: Diagnostic[];
}

// Define proper type for diagnostic information
export type ErrorDiagnostics =
  | ZodIssue[] // For validation errors
  | { name: string; stack?: string } // For regular errors
  | DiagnosticsPayload // For diagnostics payloads returned by tools
  | unknown; // For other types of diagnostics

export interface ToolFileAttachment {
  /** Workspace-relative or descriptive path for the attachment */
  path: string;
  /** MIME type for the attachment payload */
  mimeType: string;
  /** Optional human readable description */
  description?: string;
  /** Base64 encoded payload when inline transport is supported */
  base64Data?: string;
  /** Raw bytes for providers that require binary uploads */
  bytes?: Uint8Array;
}

export interface ToolResult {
  output?: string;
  summary?: string;
  error?: string;
  base64Image?: string;
  userInstruction?: string;
  isError?: boolean;
  diagnostics?: ErrorDiagnostics; // Additional error details like validation issues
  files?: ToolFileAttachment[];
}

export function toolResult(result: ToolResult): ToolResult {
  return result;
}

export const cliResult = toolResult;

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
