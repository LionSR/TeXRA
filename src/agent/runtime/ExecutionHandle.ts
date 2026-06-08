/**
 * Polymorphic execution handles.
 *
 * Replaces data-oriented maps with handles that know how to report status and
 * describe themselves. Termination policy lives with the owning registry.
 */

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamStatusRegistry } from '@agent/runtime/StreamStatusService';
import {
  LIVE_ELAPSED_STREAM_STATUSES,
  STREAM_STATUS,
  type ActiveChildInfo,
  type StreamTabId,
} from '@shared/schemas';
import { formatDuration } from '@utils/core';
import type { RunCoordinators } from './RunContext';

export interface ExecutionStatusInfo {
  status: string;
  elapsed: string | null;
}

export type StreamStatusReader = Pick<StreamStatusRegistry, 'get'>;

/** Statuses that represent a live execution (running, transitioning, or paused). */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.INITIALIZING,
  STREAM_STATUS.RESUMING,
  STREAM_STATUS.WAITING,
]);

export interface ExecutionHandle {
  readonly executionId: string;
  readonly parentStreamId: StreamTabId;
  readonly category: 'workflow' | 'toolUse' | 'process';
  readonly agentName: string;
  readonly startedAt: number;
  readonly runtimeHost: AgentRuntimeHost;

  getStatus(): ExecutionStatusInfo;

  getProgress(): { currentRound?: number; totalRounds?: number };

  updateProgress(update: { currentRound?: number; totalRounds?: number }): void;
}

export interface LiveToolUseFlowContext {
  readonly session: {
    appendFollowUp(
      text: string,
      mediaFiles?: readonly string[],
      displayText?: string,
    ): void;
  };
  readonly modelHandler: {
    readonly supportsManualCompaction: boolean;
  };
  readonly runtimeHost?: AgentRuntimeHost;

  requestImmediateCompaction(): void;
  modelSwitchDisabledReason(model: string): string | undefined;
  switchModel(model: string): Promise<void>;
}

/**
 * Handle for agent-based executions (workflow or toolUse subagents).
 * When `parentStreamId` differs from `childStreamId`, the handle represents
 * a subagent whose parent is an orchestrator.
 */
export class AgentExecutionHandle implements ExecutionHandle {
  readonly startedAt = Date.now();
  private progress: { currentRound?: number; totalRounds?: number } = {};
  private _parentStreamId: StreamTabId;
  private toolUseFlowContext?: LiveToolUseFlowContext;

  /** Stable tool name for UI identification (e.g. "bash", "codex"). */
  toolName?: string;

  constructor(
    readonly executionId: string,
    parentStreamId: StreamTabId,
    readonly childStreamId: StreamTabId,
    readonly agentName: string,
    readonly category: 'workflow' | 'toolUse',
    readonly runtimeHost: AgentRuntimeHost,
    private readonly streamStatus: StreamStatusReader,
    readonly coordinators?: RunCoordinators,
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
      this.streamStatus.get(this.childStreamId) ?? STREAM_STATUS.RUNNING;
    if (!LIVE_ELAPSED_STREAM_STATUSES.has(status)) {
      return { status, elapsed: null };
    }
    return {
      status,
      elapsed: formatDuration(Date.now() - this.startedAt),
    };
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

  attachToolUseFlow(context: LiveToolUseFlowContext): void {
    if (this.category !== 'toolUse') {
      throw new Error('Only tool-use execution handles can attach tool flows.');
    }
    this.toolUseFlowContext = context;
  }

  detachToolUseFlow(context?: LiveToolUseFlowContext): void {
    if (context !== undefined && this.toolUseFlowContext !== context) return;
    this.toolUseFlowContext = undefined;
  }

  getToolUseFlow(): LiveToolUseFlowContext | undefined {
    return this.toolUseFlowContext;
  }
}

/**
 * Handle for background bash processes.
 * No `childStreamId` — processes don't have their own stream.
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
    // Processes don't have round progress.
  }
}

/** True when the handle is a child of parentStreamId (not the parent itself). */
export function isChildExecution(
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

/** Collect {executionId, agentName, ...} for handles matching a class under a parent stream. */
export function collectChildSummary(
  parentStreamId: StreamTabId,
  handles: Iterable<ExecutionHandle>,
  ctor: typeof AgentExecutionHandle | typeof ProcessExecutionHandle,
): ActiveChildInfo[] {
  const result: ActiveChildInfo[] = [];
  for (const handle of handles) {
    if (
      !(handle instanceof ctor) ||
      !isChildExecution(handle, parentStreamId)
    ) {
      continue;
    }
    const { status, elapsed } = handle.getStatus();
    const info: ActiveChildInfo = {
      executionId: handle.executionId,
      agentName: handle.agentName,
      status,
      startedAt: handle.startedAt,
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
