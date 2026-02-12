/**
 * Polymorphic execution handles.
 *
 * Replaces data-oriented maps with handles that know how to report status,
 * interrupt/kill, and describe themselves. Eliminates the multi-registry
 * cascade in getExecutionStatusInfo and handleKill.
 */

import { bus } from '@eventBus/ProgressEventBus';
import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  STREAM_STATUS,
  type ActiveSubagentInfo,
  type StreamTabId,
} from '@shared/schemas';
import { formatDuration } from '@utils/core';

// ============================================================================
// Status types
// ============================================================================

/** Resolved status for display purposes. */
export interface ExecutionStatusInfo {
  status: string;
  elapsed: string | null;
}

/** Statuses that represent an actively running execution. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.INITIALIZING,
  STREAM_STATUS.RESUMING,
]);

// ============================================================================
// Handle interface
// ============================================================================

export interface ExecutionHandle {
  readonly executionId: string;
  readonly parentStreamId: StreamTabId;
  readonly category: 'workflow' | 'toolUse' | 'process';
  readonly agentName: string;
  readonly startedAt: number;

  /** Get current status without probing multiple registries. */
  getStatus(): ExecutionStatusInfo;

  /** Interrupt or kill. Returns true if successful. */
  terminate(): boolean;

  /** Round progress (if applicable). */
  getProgress(): { currentRound?: number; totalRounds?: number };

  /** Update round progress. */
  updateProgress(update: { currentRound?: number; totalRounds?: number }): void;
}

// ============================================================================
// AgentExecutionHandle — for workflow and toolUse subagents
// ============================================================================

/**
 * Handle for agent-based executions (workflow or toolUse subagents).
 * Absorbs the per-entry role of the former subagentLineage module.
 *
 * When `parentStreamId` differs from `childStreamId`, the handle represents
 * a subagent whose parent is an orchestrator.
 */
export class AgentExecutionHandle implements ExecutionHandle {
  readonly startedAt = Date.now();
  private progress: { currentRound?: number; totalRounds?: number } = {};

  constructor(
    readonly executionId: string,
    readonly parentStreamId: StreamTabId,
    readonly childStreamId: StreamTabId,
    readonly agentName: string,
    readonly category: 'workflow' | 'toolUse',
  ) {}

  getStatus(): ExecutionStatusInfo {
    const status =
      StreamStatusService.get(this.childStreamId) ?? STREAM_STATUS.RUNNING;
    if (!ACTIVE_STATUSES.has(status)) {
      return { status, elapsed: null };
    }
    return {
      status,
      elapsed: formatDuration(Date.now() - this.startedAt),
    };
  }

  terminate(): boolean {
    const interruptible = getInterruptible(this.childStreamId);
    if (!interruptible) return false;
    interruptible.interrupt();
    StreamStatusService.set(this.childStreamId, STREAM_STATUS.STOPPED);
    return true;
  }

  getProgress(): { currentRound?: number; totalRounds?: number } {
    return { ...this.progress };
  }

  updateProgress(update: {
    currentRound?: number;
    totalRounds?: number;
  }): void {
    Object.assign(this.progress, update);
  }
}

// ============================================================================
// ProcessExecutionHandle — for background bash
// ============================================================================

/**
 * Handle for background bash processes.
 * No childStreamId — processes don't have their own stream.
 */
export class ProcessExecutionHandle implements ExecutionHandle {
  readonly category = 'process' as const;
  readonly startedAt = Date.now();

  constructor(
    readonly executionId: string,
    readonly parentStreamId: StreamTabId,
    readonly agentName: string,
    private readonly killFn: () => void,
  ) {}

  getStatus(): ExecutionStatusInfo {
    // If handle exists in registry → running
    return {
      status: STREAM_STATUS.RUNNING,
      elapsed: formatDuration(Date.now() - this.startedAt),
    };
  }

  terminate(): boolean {
    this.killFn();
    return true;
  }

  getProgress(): { currentRound?: number; totalRounds?: number } {
    return {};
  }

  updateProgress(): void {
    // Processes don't have round progress
  }
}

// ============================================================================
// Subagent lineage helpers
// ============================================================================

/**
 * Interrupt all active subagents of a parent stream.
 * Called before interrupting the parent so subagents stop
 * promptly instead of running to completion.
 */
export function interruptActiveChildren(
  parentStreamId: StreamTabId,
  handles: Iterable<ExecutionHandle>,
): void {
  for (const handle of handles) {
    if (
      handle.parentStreamId === parentStreamId &&
      handle instanceof AgentExecutionHandle
    ) {
      handle.terminate();
    }
  }
}

/** Get summary of active agent children for a parent stream (for UI display). */
function getActiveChildrenSummary(
  parentStreamId: StreamTabId,
  handles: Iterable<[string, ExecutionHandle]>,
): ActiveSubagentInfo[] {
  const result: ActiveSubagentInfo[] = [];
  for (const [, handle] of handles) {
    if (
      handle.parentStreamId === parentStreamId &&
      handle instanceof AgentExecutionHandle
    ) {
      result.push({
        executionId: handle.executionId,
        agentName: handle.agentName,
      });
    }
  }
  return result;
}

/** Emit the current active children list for a parent to the progress UI. */
export function emitActiveSubagentsUpdate(
  parentStreamId: StreamTabId,
  handles: Iterable<[string, ExecutionHandle]>,
): void {
  const children = getActiveChildrenSummary(parentStreamId, handles);
  bus.emit('updateActiveSubagents', { parentStreamId, children });
}
