/**
 * ToolUseFlowContext - Types and utilities for tool-use flow services.
 *
 * The flow context is created inline in runToolUseFlow.ts - no factory function.
 * This module provides the type definitions and tool resolution utility.
 */

import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import type { ToolDefinition } from '@model';
import { getToolUseMemoryEnabled } from '@utils/config/constants';

import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';

/** Configuration for creating tool-use flow services. */
export interface ToolUseFlowContextInit<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentToolUseSetting;
  toolRegistry?: IToolRegistry;
  resumeSnapshot?: ToolUseSessionSnapshot | null;
  onFollowUpConsumed?: () => void;
}

// ============================================================================
// Tool Resolution
// ============================================================================

/**
 * Resolve tool definitions from agent settings, validating against registry.
 * Optionally injects the memory tool if enabled in user settings.
 *
 * @param tools - Tool configuration from agent settings
 * @param registry - Tool registry to resolve tools from
 * @param logger - Logger for warnings about missing tools
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
