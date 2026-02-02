/**
 * Tool resolution utilities for tool-use flow.
 */

import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { ToolDefinition } from '@model';
import { getToolUseMemoryEnabled } from '@utils/config/constants';

/**
 * Resolve tool definitions from agent settings, validating against registry.
 * Auto-injects the memory tool if enabled in user settings.
 */
export function resolveTools(
  tools: AgentToolUseSetting['tools'],
  registry: IToolRegistry,
  logger: { warn: (msg: string) => void },
): ToolDefinition[] {
  const toolConfigs = Array.isArray(tools) ? tools : [];

  // Normalize configs and filter to valid tools
  const resolved = toolConfigs
    .map((config) => (typeof config === 'string' ? { name: config } : config))
    .filter((def) => {
      if (!registry.has(def.name)) {
        logger.warn(`Tool "${def.name}" not found in registry`);
        return false;
      }
      return true;
    });

  // Auto-inject memory tool if enabled and not already configured
  if (getToolUseMemoryEnabled() && !resolved.some((d) => d.name === 'memory')) {
    const memoryTool = registry.get('memory');
    if (memoryTool) {
      resolved.push(memoryTool.definition);
    } else {
      logger.warn('Memory tool not found in registry');
    }
  }

  return resolved;
}
