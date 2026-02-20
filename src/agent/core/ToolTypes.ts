/**
 * Core tool type definitions for the agent system.
 *
 * Provides interfaces for tool implementations and registries:
 * - ITool: Contract for all tool implementations
 * - IToolRegistry: Minimal interface for tool lookup (get/has)
 * - MapToolRegistry: Map-backed registry implementation
 *
 * Re-exports ToolResult types from @tools/result and ToolDefinition from @model.
 */

// Import types for local use in interfaces
import type { ToolDefinition as ToolDefinitionType } from '@model/ToolDefinition';
import type { ToolResult as ToolResultType } from '@tools/result';

// Re-export tool result types from canonical location
export type {
  ToolResult,
  ErrorDiagnostics,
  DiagnosticsPayload,
  ToolFileAttachment,
} from '@tools/result';
export { ToolError } from '@tools/result';

// Re-export ToolDefinition from model
export type { ToolDefinition } from '@model/ToolDefinition';

/**
 * Interface contract for tool implementations.
 *
 * All tools must implement this interface to be usable in the agent system.
 * BaseTool provides the canonical implementation with Zod validation.
 */
export interface ITool {
  /** Tool definition containing name, description, and parameter schema */
  readonly definition: ToolDefinitionType;

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
  call(rawInput: unknown): Promise<ToolResultType>;
}

/**
 * Interface for tool registries that provide tool lookup.
 *
 * This abstraction allows:
 * - Dependency injection of custom tool sets
 * - Testing with mock tools
 */
export interface IToolRegistry {
  /**
   * Get a tool by name.
   * @returns The tool if found, undefined otherwise
   */
  get(name: string): ITool | undefined;

  /**
   * Check if a tool exists in the registry.
   * @returns True if the tool exists
   */
  has(name: string): boolean;
}

/**
 * Simple implementation of IToolRegistry backed by a Map or Record.
 * Instantiate directly: new MapToolRegistry({ name: tool, ... })
 */
export class MapToolRegistry implements IToolRegistry {
  private readonly tools: Map<string, ITool>;

  constructor(tools: Map<string, ITool> | Record<string, ITool>) {
    this.tools = tools instanceof Map ? tools : new Map(Object.entries(tools));
  }

  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
