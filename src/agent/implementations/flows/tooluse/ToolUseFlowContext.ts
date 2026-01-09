/**
 * ToolUseFlowContext - Factory for tool-use flow services.
 */

import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
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

// ============================================================================
// Context Initialization
// ============================================================================

/**
 * Configuration for creating tool-use flow services.
 *
 * Extends BaseFlowContextInit with tool-use specific fields.
 */
export interface ToolUseFlowContextInit<
  C = unknown,
> extends BaseFlowContextInit<C> {
  /** Narrow setting to tool-use specific type */
  setting: AgentToolUseSetting;

  /** Optional tool registry override */
  toolRegistry?: IToolRegistry;

  /** Optional snapshot for session resume */
  resumeSnapshot?: ToolUseSessionSnapshot | null;

  /** Optional usage tracking callback */
  getUsageRecorder?: () => RoundFinalizedCallback;

  /** Optional callback when a queued follow-up is consumed */
  onFollowUpConsumed?: () => void;
}

// ============================================================================
// Context Object (simple object, not a class)
// ============================================================================

/**
 * Tool-use flow context returned by factory function.
 * Contains services and lifecycle methods.
 */
export interface ToolUseFlowContext<C = unknown> {
  /** Services for flow execution */
  services: ToolUseServices<C>;

  /** Session lifecycle manager */
  session: ToolUseSessionLifecycle;

  /** Interrupt the session */
  interrupt(): void;

  /** Dispose context resources */
  dispose(): void;
}

// ============================================================================
// Factory Function
// ============================================================================

/** Creates a ToolUseFlowContext with services and lifecycle methods. */
export function createToolUseFlowContext<C = unknown>(
  init: ToolUseFlowContextInit<C>,
): ToolUseFlowContext<C> {
  const {
    setting,
    logger,
    streamId,
    toolRegistry: customRegistry,
    resumeSnapshot,
  } = init;

  const toolRegistry = customRegistry ?? getDefaultToolRegistry();
  const sessionLifecycle = new ToolUseSessionLifecycle(streamId);

  // Resolve tools once at construction time
  const toolConfigs = Array.isArray(setting.tools) ? setting.tools : [];
  const resolvedTools: ToolDefinition[] = [];
  const resolvedNames = new Set<string>();
  for (const t of toolConfigs) {
    const def = typeof t === 'string' ? { name: t } : t;
    if (!toolRegistry.has(def.name)) {
      logger.warn(`Tool "${def.name}" not found in registry`);
      continue;
    }
    resolvedTools.push(def);
    resolvedNames.add(def.name);
  }

  if (getToolUseMemoryEnabled() && !resolvedNames.has('memory')) {
    const memoryTool = toolRegistry.get('memory');
    if (memoryTool) {
      resolvedTools.push(memoryTool.definition);
      resolvedNames.add('memory');
    } else {
      logger.warn('Memory tool not found in registry');
    }
  }

  // Spread init directly - it already contains setting, logger, etc.
  const services: ToolUseServices<C> = {
    ...init,
    toolRegistry, // May differ from init if defaulted
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
