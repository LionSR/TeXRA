/**
 * Core tool type definitions for the agent system.
 *
 * This module provides the SINGLE SOURCE OF TRUTH for tool-related interfaces
 * used across the agent and tools packages. It defines:
 *
 * 1. ITool - Interface contract for all tool implementations
 * 2. IToolRegistry - Interface for tool lookup and enumeration
 * 3. Re-exports of ToolResult and related types from tools/result
 *
 * This enables:
 * - Dependency injection (agents accept IToolRegistry instead of concrete types)
 * - Cleaner separation between agent core and tool implementations
 * - Testability (mock registries can be injected)
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
export { toolResult, cliResult, ToolError } from '@tools/result';

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

/**
 * Create an IToolRegistry from a Record of tools.
 *
 * Map<string, ITool> structurally satisfies IToolRegistry, so we use it
 * directly without a wrapper class. This eliminates the MapToolRegistry
 * pure delegation class.
 *
 * @param tools - Record mapping tool names to ITool implementations
 * @returns An IToolRegistry (actually a Map) wrapping the tools
 */
export function createToolRegistry(
  tools: Record<string, ITool>,
): IToolRegistry {
  return new Map(Object.entries(tools));
}
