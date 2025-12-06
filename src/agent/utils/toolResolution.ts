/**
 * Shared utility for resolving tool names to tool definitions.
 *
 * This module provides a single source of truth for tool resolution logic,
 * used by both local agent loading and remote agent loading.
 */

// Type imports
import type { ToolDefinition } from '@model';
import type { ITool } from '@agent/core/ToolTypes';

/** Logger channel for tool resolution */
const CHANNEL = 'toolResolution';

/** Options for tool resolution */
export interface ResolveToolsOptions {
  /** Logger function for warnings (optional, defaults to console.warn) */
  warn?: (channel: string, message: string) => void;
}

/**
 * Represents a tool reference in agent configuration.
 * Can be either a string name or an inline tool definition.
 */
export type ToolReference = string | ToolDefinition;

/**
 * Simple tool lookup interface - accepts plain Record<string, ITool>.
 */
type ToolLookup = Record<string, ITool | undefined>;

/**
 * Resolves an array of tool references to tool definitions.
 *
 * Tool references can be:
 * - String names that map to registered tools
 * - Inline tool definitions
 *
 * @param tools - Array of tool references (strings or definitions)
 * @param registry - Tool registry record to look up tool definitions
 * @param options - Optional configuration for logging
 * @returns Array of resolved tool definitions
 */
export function resolveToolDefinitions(
  tools: ToolReference[],
  registry: ToolLookup,
  options?: ResolveToolsOptions,
): ToolDefinition[] {
  const warn = options?.warn ?? ((_ch, msg) => console.warn(msg));

  return tools.map((item): ToolDefinition => {
    if (typeof item === 'string') {
      const tool = registry[item];
      if (!tool) {
        warn(CHANNEL, `Tool "${item}" not found in registry`);
        // Return a stub definition for unknown tools
        // This preserves the tool name so errors are clear downstream
        return { name: item };
      }
      return tool.definition;
    }

    // Item is already a tool definition object
    const toolDef = item as ToolDefinition;
    if (!registry[toolDef.name]) {
      warn(CHANNEL, `Tool "${toolDef.name}" not found in registry`);
    }
    return toolDef;
  });
}

/**
 * Lazily loads the default tool registry and resolves tools.
 *
 * This is a convenience function that handles the dynamic import of the
 * tool registry, useful for avoiding circular dependencies.
 *
 * @param tools - Array of tool references (strings or definitions)
 * @param options - Optional configuration for logging
 * @returns Promise resolving to array of tool definitions
 */
export async function resolveToolDefinitionsAsync(
  tools: ToolReference[],
  options?: ResolveToolsOptions,
): Promise<ToolDefinition[]> {
  const { DEFAULT_TOOL_REGISTRY } = await import('@tools/registry');
  return resolveToolDefinitions(tools, DEFAULT_TOOL_REGISTRY, options);
}
