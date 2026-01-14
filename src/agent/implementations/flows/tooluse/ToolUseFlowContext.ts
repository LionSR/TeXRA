/**
 * ToolUseFlowContext - Types and utilities for tool-use flow services.
 *
 * The flow context is created inline in runToolUseFlow.ts - no factory function.
 * This module provides the type definitions and tool resolution utility.
 */

import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { ToolDefinition } from '@model';
import { getDefaultToolRegistry } from '@tools/registry';
import { getToolUseMemoryEnabled } from '@utils/config/constants';

import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';

/** Configuration for creating tool-use flow services. */
export interface ToolUseFlowContextInit<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentToolUseSetting;
  toolRegistry?: IToolRegistry;
  resumeSnapshot?: ToolUseSessionSnapshot | null;
  getUsageRecorder?: () => RoundFinalizedCallback;
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
 * @param registry - Optional tool registry (defaults to global registry)
 * @param logger - Logger for warnings about missing tools
 */
export function resolveTools(
  tools: AgentToolUseSetting['tools'],
  registry: IToolRegistry | undefined,
  logger: { warn: (msg: string) => void },
): ToolDefinition[] {
  const toolRegistry = registry ?? getDefaultToolRegistry();
  const toolConfigs = Array.isArray(tools) ? tools : [];

  const resolved: ToolDefinition[] = [];
  const resolvedNames = new Set<string>();

  for (const config of toolConfigs) {
    const def = typeof config === 'string' ? { name: config } : config;

    if (!toolRegistry.has(def.name)) {
      logger.warn(`Tool "${def.name}" not found in registry`);
      continue;
    }

    resolved.push(def);
    resolvedNames.add(def.name);
  }

  // Auto-inject memory tool if enabled and not already configured
  if (getToolUseMemoryEnabled() && !resolvedNames.has('memory')) {
    const memoryTool = toolRegistry.get('memory');
    if (memoryTool) {
      resolved.push(memoryTool.definition);
    } else {
      logger.warn('Memory tool not found in registry');
    }
  }

  return resolved;
}
