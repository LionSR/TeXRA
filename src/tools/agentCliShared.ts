// Shared helpers for the agent-CLI tool modules (codex.ts, claudeAgent.ts).
// Host-agnostic, VS Code-free.

import { type AgentTrace } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  EXECUTION_STATUS,
  type ExecutionStatus,
  type StreamStatus,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import { formatDuration } from '@utils/core';

/** True for an AbortController-style cancellation error. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * True when an error/abort represents a clean, caller-initiated interruption
 * rather than a genuine failure.
 */
export function isCleanInterruption(
  err: unknown,
  signal: AbortSignal,
  session: { isInterrupted(): boolean },
): boolean {
  return signal.aborted || session.isInterrupted() || isAbortError(err);
}

/** Transient statuses owned by a running agent loop. */
export function isLoopOwnedStatus(status: StreamStatus | undefined): boolean {
  return status === STREAM_STATUS.WAITING || status === STREAM_STATUS.RUNNING;
}

export function agentCliLoopTerminalStatus(
  sawTurnFailure: boolean,
): ExecutionStatus {
  return sawTurnFailure ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.COMPLETED;
}

export function markAgentCliLoopError(
  childStreamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
): void {
  if (StreamStatusService.get(childStreamId) !== STREAM_STATUS.STOPPED) {
    StreamStatusService.set(childStreamId, STREAM_STATUS.ERROR, {
      runtimeHost,
    });
  }
}

export function finalizeAgentCliLoopStatus(
  childStreamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
): void {
  if (isLoopOwnedStatus(StreamStatusService.get(childStreamId))) {
    StreamStatusService.set(childStreamId, STREAM_STATUS.READY, {
      runtimeHost,
    });
  }
}

/** Log a turn summary (duration + token usage) to the child stream. */
export function logTurnSummary(
  logger: AgentTrace,
  wallTimeMs: number,
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined,
): void {
  logger.info(`Turn completed in ${formatDuration(wallTimeMs)}`);
  if (usage) {
    logger.info(
      `Tokens: ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`,
    );
  }
}
