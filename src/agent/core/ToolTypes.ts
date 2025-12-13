/**
 * Core tool implementations for the agent system.
 *
 * Types (ITool, IToolRegistry, ToolResult, etc.) are in @shared/tools.
 * This module provides:
 * - MapToolRegistry implementation
 * - createToolRegistry factory
 * - Re-exports of toolResult, cliResult, ToolError from @tools/result
 */

// Shared types
import type { ITool, IToolRegistry } from '@shared/tools';

// Re-export result factory functions
export { toolResult, cliResult, ToolError } from '@tools/result';

/**
 * Simple implementation of IToolRegistry backed by a Map or Record.
 *
 * Use createToolRegistry() to wrap an existing Record<string, ITool>.
 */
export class MapToolRegistry implements IToolRegistry {
  private readonly tools: Map<string, ITool>;

  constructor(tools: Map<string, ITool> | Record<string, ITool>) {
    this.tools = tools instanceof Map ? tools : new Map(Object.entries(tools));
  }

  get size(): number {
    return this.tools.size;
  }

  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  keys(): IterableIterator<string> {
    return this.tools.keys();
  }

  values(): IterableIterator<ITool> {
    return this.tools.values();
  }

  entries(): IterableIterator<[string, ITool]> {
    return this.tools.entries();
  }
}

/**
 * Create an IToolRegistry from a Record of tools.
 *
 * @param tools - Record mapping tool names to ITool implementations
 * @returns An IToolRegistry wrapping the tools
 */
export function createToolRegistry(
  tools: Record<string, ITool>,
): IToolRegistry {
  return new MapToolRegistry(tools);
}
