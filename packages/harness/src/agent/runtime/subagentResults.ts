/**
 * Formatting utilities for subagent results and progress updates.
 *
 * Format helpers convert a run's terminal facts and progress updates into
 * structured XML strings for follow-up delivery to the orchestrator.
 *
 * Design: Typed objects internally, XML formatting only at the boundary
 * (just before injection into model context as a queued follow-up).
 */

import {
  type AttachedMemoryMiss,
  type RetryErrorInfo,
  type RunEndOutput,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { formatDelivery } from './deliveryEnvelope';
import type { RecipeResult } from './recipeResult';

// ============================================================================
// Formatting helpers
// ============================================================================

/** The run facts a result or error delivery carries beside its body. */
interface DeliveryContext {
  readonly wallTimeMs?: number;
  readonly workingDirectory?: string;
  readonly memoryMisses?: readonly AttachedMemoryMiss[];
}

/**
 * Shared context lines for both native delivery and error messages:
 * working-directory, then memory-misses, in that order (rendered right after
 * the builder-owned wall-time).
 */
function formatDeliveryPreamble(options: DeliveryContext): string[] {
  const lines: string[] = [];
  if (options.workingDirectory) {
    lines.push(
      `<working-directory>${escapeText(options.workingDirectory)}</working-directory>`,
    );
  }
  const misses = options.memoryMisses ?? [];
  if (misses.length > 0) {
    lines.push(
      '<memory-misses>',
      ...misses.map(
        (miss) =>
          `<memory-miss path="${escapeAttr(miss.path)}" reason="${escapeAttr(miss.reason)}" />`,
      ),
      '</memory-misses>',
    );
  }
  return lines;
}

/**
 * Format a run's terminal result as a delivery message, queued as a follow-up
 * for the orchestrator, which reads it as a user-role message. A recipe's
 * run is delivered as its block reads it (`recipe`); any other run as its
 * reply and the files its tool calls touched.
 */
export function formatSubagentDelivery(
  agentName: string,
  result: { readonly outcome: RunOutcome; readonly output: RunEndOutput },
  options: DeliveryContext & {
    readonly runId: RunId;
    readonly recipe?: RecipeResult;
  },
): string {
  const lines = formatDeliveryPreamble(options);
  const { output } = result;
  const { recipe } = options;
  if (recipe !== undefined && recipe.delivery.length > 0) {
    lines.push(...recipe.delivery);
  } else {
    if (output.response) {
      lines.push('<response>', escapeText(output.response), '</response>');
    }
    if (output.files.length > 0) {
      lines.push(
        '<touched-files>',
        ...output.files.map((f) => `<file path="${escapeAttr(f)}" />`),
        '</touched-files>',
      );
    }
  }

  return formatDelivery({
    tag: DELIVERY_TAG.subagentResult,
    runId: options.runId,
    attributes: [
      { name: 'agent', value: agentName },
      ...(recipe !== undefined ? [{ name: 'kind', value: recipe.key }] : []),
      { name: 'status', value: result.outcome },
    ],
    wallTime:
      options.wallTimeMs !== undefined
        ? `${(options.wallTimeMs / 1000).toFixed(1)}s`
        : undefined,
    lines,
  });
}

/**
 * Format a child's normalized failure as a delivery message.
 */
export function formatSubagentError(
  runId: string,
  agentName: string,
  formatted: Pick<RetryErrorInfo, 'message' | 'userRetryable'>,
  options: DeliveryContext & { readonly wallTimeMs: number },
): string {
  return formatDelivery({
    tag: DELIVERY_TAG.subagentError,
    runId,
    attributes: [
      { name: 'agent', value: agentName },
      { name: 'retryable', value: formatted.userRetryable },
    ],
    wallTime: `${(options.wallTimeMs / 1000).toFixed(1)}s`,
    lines: formatDeliveryPreamble(options),
    message: formatted.message,
  });
}
