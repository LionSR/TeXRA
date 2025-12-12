/**
 * Core tool type definitions shared across the codebase.
 *
 * This module is part of the @types/ layer - the foundation that all other
 * layers can import from without creating circular dependencies.
 *
 * IMPORTANT: This module contains ONLY interfaces and types.
 * Implementations (toolResult, createToolRegistry, etc.) remain in their
 * original locations (@tools/result, @agent/core/ToolTypes).
 *
 * This enables:
 * - Dependency injection (agents accept IToolRegistry instead of concrete types)
 * - Breaking circular dependencies between @agent and @tools
 * - Cleaner separation between agent core and tool implementations
 * - Testability (mock registries can be injected)
 */
import { z } from 'zod';

// ============================================================================
// Tool Result Types (schemas and types only, no factory functions)
// ============================================================================

/**
 * Schema for line change statistics.
 * Single source of truth - used by ToolResult, edits, and model handlers.
 */
export const LineChangesSchema = z.object({
  added: z.number(),
  removed: z.number(),
});
export type LineChanges = z.infer<typeof LineChangesSchema>;

/**
 * Base schema for file references (metadata only, no binary data).
 * Used when binary data has been stripped for serialization/logging.
 */
export const FileReferenceSchema = z.object({
  /** Workspace-relative or descriptive path for the file */
  path: z.string(),
  /** MIME type for the file */
  mimeType: z.string(),
  /** Optional human readable description */
  description: z.string().optional(),
});
export type FileReference = z.infer<typeof FileReferenceSchema>;

/**
 * Schema for file attachments with optional binary data.
 * Extends FileReferenceSchema with binary payload fields.
 */
export const ToolFileAttachmentSchema = FileReferenceSchema.extend({
  /** Base64 encoded payload when inline transport is supported */
  base64Data: z.string().optional(),
  /** Raw bytes for providers that require binary uploads */
  bytes: z.custom<Uint8Array>((val) => val instanceof Uint8Array).optional(),
});
export type ToolFileAttachment = z.infer<typeof ToolFileAttachmentSchema>;

/**
 * Schema for edit records in tool results.
 */
export const EditRecordSchema = z.object({
  path: z.string(),
  lineChanges: LineChangesSchema.optional(),
});
export type EditRecord = z.infer<typeof EditRecordSchema>;

/**
 * Schema for tool execution results.
 * Uses looseObject to allow additional properties for forward compatibility.
 */
export const ToolResultSchema = z.looseObject({
  /** Detailed output from the tool */
  output: z.string().optional(),
  /** Brief summary of the tool execution result */
  summary: z.string().optional(),
  /** Error message if tool execution failed */
  error: z.string().optional(),
  /** User instruction that was processed */
  userInstruction: z.string().optional(),
  /** User-provided patch content */
  userPatch: z.string().optional(),
  /** Statistics about line changes made */
  lineChanges: LineChangesSchema.optional(),
  /** Records of edits made during tool execution */
  edits: z.array(EditRecordSchema).optional(),
  /** Whether this result represents an error */
  isError: z.boolean().optional(),
  /** Additional diagnostic information */
  diagnostics: z.unknown().optional(),
  /** File attachments (may contain binary data) */
  files: z.array(ToolFileAttachmentSchema).optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

// ============================================================================
// Tool Definition Types (re-exported for convenience)
// ============================================================================

/**
 * Tool definition schema - defines what a tool does and its parameters.
 * This is the canonical definition from @model/ToolDefinition.
 */
export const ToolDefinitionSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// ============================================================================
// Tool Interfaces (for dependency injection)
// ============================================================================

/**
 * Interface contract for tool implementations.
 *
 * All tools must implement this interface to be usable in the agent system.
 * BaseTool provides the canonical implementation with Zod validation.
 */
export interface ITool {
  /** Tool definition containing name, description, and parameter schema */
  readonly definition: ToolDefinition;

  /**
   * Execute the tool with the given input.
   *
   * Implementations should:
   * 1. Validate the input
   * 2. Execute the tool logic
   * 3. Return a ToolResult (success or error)
   *
   * @param rawInput - The raw input to validate and process
   * @returns Promise resolving to a ToolResult
   */
  call(rawInput: unknown): Promise<ToolResult>;
}

/**
 * Interface for tool registries that provide tool lookup and enumeration.
 *
 * This abstraction allows:
 * - Dependency injection of custom tool sets
 * - Filtering tools at runtime
 * - Testing with mock tools
 */
export interface IToolRegistry {
  /** Number of tools in the registry */
  readonly size: number;

  /**
   * Get a tool by name.
   * @param name - The tool name
   * @returns The tool if found, undefined otherwise
   */
  get(name: string): ITool | undefined;

  /**
   * Check if a tool exists in the registry.
   * @param name - The tool name
   * @returns True if the tool exists
   */
  has(name: string): boolean;

  /**
   * Get all tool names in the registry.
   * @returns Iterator of tool names
   */
  keys(): IterableIterator<string>;

  /**
   * Get all tools in the registry.
   * @returns Iterator of tool values
   */
  values(): IterableIterator<ITool>;

  /**
   * Get all tools in the registry.
   * @returns Iterator of [name, tool] pairs
   */
  entries(): IterableIterator<[string, ITool]>;
}

// ============================================================================
// Diagnostics Types (complex unions, not suitable for Zod)
// ============================================================================

export interface DiagnosticsPayload {
  path: string;
  command: 'list' | 'count';
  severity: Record<string, number>;
  messages?: unknown[]; // VS Code Diagnostic type
}

export type ErrorDiagnostics =
  | { issues: unknown[] } // For Zod validation errors
  | { name: string; stack?: string } // For regular errors
  | DiagnosticsPayload // For diagnostics payloads returned by tools
  | unknown; // For other types of diagnostics
