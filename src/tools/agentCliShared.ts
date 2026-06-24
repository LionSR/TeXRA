// Shared helpers for the agent-CLI tool modules (codex.ts, claudeAgent.ts).
// Host-agnostic, VS Code-free.

import { type AgentTrace } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { isAbortError, toErrorMessage } from '@common/errors';
import type {
  ExecutionId,
  StorageKey,
  StreamTabId,
  TokenUsageStats,
} from '@shared/schemas';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { formatDuration } from '@utils/core';

/** Maximum prompt length echoed back in a delivery/error XML element. */
const DELIVERY_PROMPT_MAX = 200;

export interface AgentCliDeliveryParams {
  /** Root element name, e.g. `codex-result` or `claude-agent-result`. */
  tag: string;
  executionId: string;
  prompt: string;
  wallTimeMs: number;
  /** Final assistant response; falls back to `(no response)` when empty. */
  response: string;
  /**
   * Optional session/thread identifier rendered as an attribute on the root
   * element (e.g. `thread-id` for codex, `session-id` for claude). Omitted when
   * the value is falsy.
   */
  idAttr?: { name: string; value: string | null | undefined };
  /** Token usage; omitted from output when null/undefined. */
  usage?: { input: number; output: number } | null;
  /** Extra child lines appended before the closing tag (e.g. cost). */
  extraLines?: readonly string[];
}

/**
 * Build the `<...-result>` XML delivered to the parent's follow-up queue when an
 * agent-CLI turn completes. Shared by the codex and claudeAgent strategies;
 * provider differences (tag, id attribute, extra lines) are parameters.
 */
export function formatAgentCliDelivery(params: AgentCliDeliveryParams): string {
  const { tag, executionId, prompt, wallTimeMs, usage, extraLines } = params;
  const durationSec = (wallTimeMs / 1000).toFixed(1);
  const response = params.response || '(no response)';
  const idAttr = params.idAttr?.value
    ? ` ${params.idAttr.name}="${escapeAttr(params.idAttr.value)}"`
    : '';
  const lines = [
    `<${tag} id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, DELIVERY_PROMPT_MAX))}"${idAttr}>`,
    `<wall-time>${durationSec}s</wall-time>`,
    `<response>${escapeText(response)}</response>`,
  ];
  if (usage) {
    lines.push(`<usage input="${usage.input}" output="${usage.output}" />`);
  }
  if (extraLines) lines.push(...extraLines);
  lines.push(`</${tag}>`);
  return lines.join('\n');
}

/**
 * Build the `<...-error>` XML delivered when an agent-CLI turn fails. Identical
 * shape across providers apart from the element name.
 */
export function formatAgentCliError(
  tag: string,
  executionId: string,
  prompt: string,
  err: unknown,
): string {
  return [
    `<${tag} id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, DELIVERY_PROMPT_MAX))}">`,
    `<message>${escapeText(toErrorMessage(err))}</message>`,
    `</${tag}>`,
  ].join('\n');
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
