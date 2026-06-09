/**
 * Polymorphic execution handles.
 *
 * Replaces data-oriented maps with handles that know how to report status and
 * describe themselves. Termination policy lives with the owning registry.
 */

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { FollowUpQueueInput } from '@agent/toolUse/FollowUpQueue';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';
import type { AgentCategory } from '@shared/schemas/agent';
import type { RunCoordinators } from './RunContext';

/** Round counters tracked per execution (both absent until the first update). */
export interface ExecutionProgress {
  currentRound?: number;
  totalRounds?: number;
}

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

export interface ExecutionHandle {
  readonly executionId: string;
  readonly parentStreamId: StreamTabId;
  readonly category: AgentCategory | 'process';
  readonly agentName: string;
  readonly startedAt: number;
  readonly runtimeHost: AgentRuntimeHost;

  getProgress(): ExecutionProgress;

  updateProgress(update: ExecutionProgress): void;
}

export interface LiveToolUseFlowContext {
  readonly session: {
    appendFollowUp(followUp: FollowUpQueueInput): void;
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
  private progress: ExecutionProgress = {};
  private _parentStreamId: StreamTabId;
  private toolUseFlowContext?: LiveToolUseFlowContext;

  /** Stable tool name for UI identification (e.g. "bash", "codex"). */
  toolName?: string;

  constructor(
    readonly executionId: string,
    parentStreamId: StreamTabId,
    readonly childStreamId: StreamTabId,
    readonly agentName: string,
    readonly category: AgentCategory,
    readonly runtimeHost: AgentRuntimeHost,
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

  getProgress(): ExecutionProgress {
    return { ...this.progress };
  }

  updateProgress(update: ExecutionProgress): void {
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

  terminate(): boolean {
    return this.killFn();
  }

  getProgress(): ExecutionProgress {
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
