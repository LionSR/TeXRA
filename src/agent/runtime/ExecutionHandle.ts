/**
 * Polymorphic execution handles.
 *
 * Replaces data-oriented maps with handles that know how to report status,
 * interrupt/kill, and describe themselves. Eliminates the multi-registry
 * cascade in getExecutionStatusInfo and handleKill.
 */

import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  STREAM_STATUS,
  type ActiveChildInfo,
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

/** Statuses that represent a live execution (running, transitioning, or paused). */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.INITIALIZING,
  STREAM_STATUS.RESUMING,
  STREAM_STATUS.WAITING,
]);

/** Statuses where the execution is actively processing (show elapsed time). */
const PROCESSING_STATUSES: ReadonlySet<string> = new Set([
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
  readonly runtimeHost: AgentRuntimeHost;

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
  private _parentStreamId: StreamTabId;

  /** Stable tool name for UI identification (e.g. "bash", "codex"). */
  toolName?: string;

  constructor(
    readonly executionId: string,
    parentStreamId: StreamTabId,
    readonly childStreamId: StreamTabId,
    readonly agentName: string,
    readonly category: 'workflow' | 'toolUse',
    readonly runtimeHost: AgentRuntimeHost,
  ) {
    this._parentStreamId = parentStreamId;
  }

  get parentStreamId(): StreamTabId {
    return this._parentStreamId;
  }

  /** Promote this subagent to a top-level execution (detach from parent). */
  detach(): void {
    this._parentStreamId = this.childStreamId;
  }

  getStatus(): ExecutionStatusInfo {
    const status =
      StreamStatusService.get(this.childStreamId) ?? STREAM_STATUS.RUNNING;
    if (!PROCESSING_STATUSES.has(status)) {
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
    StreamStatusService.set(this.childStreamId, STREAM_STATUS.STOPPED, {
      runtimeHost: this.runtimeHost,
    });
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

  /** Ephemeral temp file paths for live output (set after construction, cleared on completion). */
  outputPaths?: { readonly stdout: string; readonly stderr: string };

  /** Stable tool name for UI identification (e.g. "bash", "codex"). */
  toolName?: string;

  constructor(
    readonly executionId: string,
    readonly parentStreamId: StreamTabId,
    readonly agentName: string,
    private readonly killFn: () => boolean,
    readonly runtimeHost: AgentRuntimeHost,
  ) {}

  getStatus(): ExecutionStatusInfo {
    // If handle exists in registry → running
    return {
      status: STREAM_STATUS.RUNNING,
      elapsed: formatDuration(Date.now() - this.startedAt),
    };
  }

  terminate(): boolean {
    return this.killFn();
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

/** True when the handle is a child of parentStreamId (not the parent itself). */
function isChildOf(
  handle: ExecutionHandle,
  parentStreamId: StreamTabId,
): boolean {
  if (handle.parentStreamId !== parentStreamId) return false;
  // AgentExecutionHandles where childStreamId === parentStreamId represent
  // the parent itself, not a child.
  if (handle instanceof AgentExecutionHandle) {
    return handle.childStreamId !== parentStreamId;
  }
  return true;
}

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
    if (isChildOf(handle, parentStreamId)) {
      handle.terminate();
    }
  }
}

/** Collect {executionId, agentName} for handles matching a class under a parent stream. */
export function collectChildSummary(
  parentStreamId: StreamTabId,
  handles: Iterable<ExecutionHandle>,
  ctor: typeof AgentExecutionHandle | typeof ProcessExecutionHandle,
): ActiveChildInfo[] {
  const result: ActiveChildInfo[] = [];
  for (const handle of handles) {
    if (!(handle instanceof ctor) || !isChildOf(handle, parentStreamId)) {
      continue;
    }
    const { status, elapsed } = handle.getStatus();
    const info: ActiveChildInfo = {
      executionId: handle.executionId,
      agentName: handle.agentName,
      status,
      elapsed: elapsed ?? null,
    };
    if (handle instanceof AgentExecutionHandle) {
      info.childStreamId = handle.childStreamId;
      if (handle.toolName) info.toolName = handle.toolName;
    } else if (handle instanceof ProcessExecutionHandle && handle.toolName) {
      info.toolName = handle.toolName;
    }
    result.push(info);
  }
  return result;
}
