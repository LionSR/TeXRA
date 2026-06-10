// Shared helpers for the agent-CLI tool modules (codex.ts, claudeAgent.ts).
// Host-agnostic, VS Code-free.

import { type AgentTrace } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { isAbortError } from '@common/errors';
import type {
  ExecutionId,
  StorageKey,
  StreamTabId,
  TokenUsageStats,
} from '@shared/schemas';
import { formatDuration } from '@utils/core';

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

/**
 * Publish a turn's token usage to the progress UI for an agent-CLI child stream.
 * Shared by the codex and claudeAgent session strategies.
 */
export function publishAgentCliStreamUsage(
  childStreamId: StreamTabId,
  executionId: ExecutionId,
  usage: TokenUsageStats,
  runtimeHost: AgentRuntimeHost,
): void {
  runtimeHost.emit('updateStreamUsage', {
    streamId: childStreamId,
    storageKey: executionId as StorageKey,
    executionId,
    usage,
  });
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
