/**
 * @file ToolTypes.ts
 *
 * Tool-related type definitions for the agent system.
 * This is the single source of truth for tool interfaces.
 * Tool implementations in @tools should implement these interfaces.
 */
// Type imports
import type { ToolDefinition } from '@model';
import type { Diagnostic } from 'vscode';
import type { ZodIssue } from 'zod';

// Local imports - model

// =============================================================================
// Diagnostics Types
// =============================================================================

/** Payload structure for diagnostics returned by tools. */
export interface DiagnosticsPayload {
  path: string;
  command: 'list' | 'count';
  severity: Record<string, number>;
  messages?: Diagnostic[];
}

/** Union type for diagnostic information attached to tool errors. */
export type ErrorDiagnostics =
  | ZodIssue[] // For validation errors
  | { name: string; stack?: string } // For regular errors
  | DiagnosticsPayload // For diagnostics payloads returned by tools
  | unknown; // For other types of diagnostics

// =============================================================================
// Tool Result Types
// =============================================================================

/** File attachment returned by a tool. */
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

/** Result returned by a tool execution. */
export interface ToolResult {
  output?: string;
  summary?: string;
  error?: string;
  base64Image?: string;
  userInstruction?: string;
  userPatch?: string;
  lineChanges?: { added: number; removed: number };
  edits?: {
    path: string;
    lineChanges?: { added: number; removed: number };
  }[];
  isError?: boolean;
  diagnostics?: ErrorDiagnostics;
  files?: ToolFileAttachment[];
}

/** Helper function to create a ToolResult with type inference. */
export function toolResult(result: ToolResult): ToolResult {
  return result;
}

// =============================================================================
// Tool Interface
// =============================================================================

/**
 * Interface for a tool that can be invoked by agents.
 * Tool implementations should implement this interface.
 */
export interface ITool {
  /** Tool definition including name, description, and input schema. */
  readonly definition: ToolDefinition;

  /**
   * Execute the tool with the given input.
   * @param rawInput - The raw input to validate and pass to the tool
   * @returns A ToolResult containing either the output or error information
   */
  call(rawInput: unknown): Promise<ToolResult>;
}

// =============================================================================
// Tool Registry Interface
// =============================================================================

/**
 * Registry mapping tool names to tool implementations.
 * This interface abstracts tool lookup from agent implementations.
 */
export type IToolRegistry = Record<string, ITool>;

// =============================================================================
// Error Types
// =============================================================================

/** Error thrown by tool implementations. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
