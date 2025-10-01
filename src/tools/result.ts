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

export interface ToolResultFile {
  path: string;
  name?: string;
  mimeType?: string;
  description?: string;
  data?: string;
}

export interface ToolResultAttachment extends ToolResultFile {
  data: string;
  size?: number;
  dataUri: string;
}

export interface ToolResult {
  output?: string;
  summary?: string;
  error?: string;
  base64Image?: string;
  system?: string;
  isError?: boolean;
  diagnostics?: ErrorDiagnostics; // Additional error details like validation issues
  files?: ToolResultFile[];
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
