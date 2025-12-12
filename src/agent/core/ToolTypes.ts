/**
 * Core tool type definitions for the agent system.
 *
 * This module re-exports shared tool interfaces from @shared/tools and provides
 * the MapToolRegistry implementation. The interfaces (ITool, IToolRegistry) are
 * now in @shared/tools to break circular dependencies between @agent and @tools.
 *
 * This enables:
 * - Dependency injection (agents accept IToolRegistry instead of concrete types)
 * - Breaking circular dependencies between @agent and @tools
 * - Cleaner separation between agent core and tool implementations
 * - Testability (mock registries can be injected)
 */

// Re-export shared types from @shared/tools (SSOT for interfaces)
// New code should import directly from '@shared/tools'
export type {
  ITool,
  IToolRegistry,
  ToolResult,
  ToolDefinition,
  ToolFileAttachment,
  ErrorDiagnostics,
  DiagnosticsPayload,
  LineChanges,
  EditRecord,
} from '@shared/tools';

// Import for local use in implementation
import type { ITool, IToolRegistry } from '@shared/tools';

// Re-export factory functions from @tools/result (implementations stay there)
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
