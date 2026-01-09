/**
 * ToolUseFlowContext - Factory for tool-use flow services.
 */

import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { ToolDefinition } from '@model';
import { getDefaultToolRegistry } from '@tools/registry';
import { getToolUseMemoryEnabled } from '@utils/config/constants';
import {
  ToolUseSessionLifecycle,
  type IToolUseSession,
} from './ToolUseSessionLifecycle';

import type { ToolUseServices } from './ToolUseServices';
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

/** Tool-use flow context returned by factory function. */
export interface ToolUseFlowContext<C = unknown> {
  services: ToolUseServices<C>;
  session: ToolUseSessionLifecycle;
  interrupt(): void;
  dispose(): void;
}

// ============================================================================
// Tool Resolution
// ============================================================================

interface ToolResolutionContext {
  toolRegistry: IToolRegistry;
  logger: { warn: (msg: string) => void };
}

/** Normalize tool config to a ToolDefinition. */
function normalizeToolConfig(config: string | ToolDefinition): ToolDefinition {
  return typeof config === 'string' ? { name: config } : config;
}

/**
 * Resolve tool definitions from agent settings, validating against registry.
 * Optionally injects the memory tool if enabled in user settings.
 */
function resolveTools(
  tools: AgentToolUseSetting['tools'],
  ctx: ToolResolutionContext,
): ToolDefinition[] {
  const { toolRegistry, logger } = ctx;
  const toolConfigs = Array.isArray(tools) ? tools : [];

  // Resolve configured tools
  const resolved: ToolDefinition[] = [];
  const resolvedNames = new Set<string>();

  for (const config of toolConfigs) {
    const def = normalizeToolConfig(config);

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

// ============================================================================
// Factory Function
// ============================================================================

/** Creates a ToolUseFlowContext with services and lifecycle methods. */
export function createToolUseFlowContext<C = unknown>(
  init: ToolUseFlowContextInit<C>,
): ToolUseFlowContext<C> {
  const { setting, logger, streamId, resumeSnapshot } = init;

  const toolRegistry = init.toolRegistry ?? getDefaultToolRegistry();
  const sessionLifecycle = new ToolUseSessionLifecycle(streamId);

  const resolvedTools = resolveTools(setting.tools, { toolRegistry, logger });

  const services: ToolUseServices<C> = {
    ...init,
    toolRegistry,
    session: sessionLifecycle,
    resolvedTools,
    snapshot: resumeSnapshot ?? null,
    getUsageRecorder: init.getUsageRecorder ?? (() => async () => {}),
  };

  return {
    services,
    session: sessionLifecycle,

    interrupt(): void {
      init.onInterrupt?.();
      retryCoordinator.clearRequest(streamId);
      sessionLifecycle.interrupt();
    },

    dispose(): void {
      sessionLifecycle.dispose();
    },
  };
}
