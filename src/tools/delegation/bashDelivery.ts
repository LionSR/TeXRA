/**
 * Formatting utilities for background-bash result delivery.
 *
 * Format helpers convert a completed or failed background bash run into
 * structured XML strings for FollowUpQueue delivery to the orchestrator,
 * including a tail/head output excerpt for long streams.
 */

import { DELIVERY_TAG } from '@shared/deliveryTags';

import { escapeText } from '@shared/utils/xmlEscape';
import { formatDuration } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { splitContentLines } from '@utils/text/stringUtils';

import type { ExecResult } from '@shared/schemas';
import {
  formatChildRunDelivery,
  formatChildRunError,
} from './deliveryEnvelope';

/** Last N lines of output for the delivery preview. */
const OUTPUT_PREVIEW_LINES = 20;

/** Tail/head excerpt plus the elided-character gap for one output stream. */
export interface BashDeliveryStreamExcerpt {
  tail: string;
  /**
   * Only pass this (non-empty) when the stream was actually truncated — the
   * caller (bash.ts) preserves a small head budget alongside the tail so a
   * long run's first fatal error survives even once total output exceeds the
   * tail budget. Unlike the tail preview, the head is emitted
   * as-is and may end mid-line — it's a best-effort char-capped excerpt, not a
   * line-bounded preview, and a truncated trailing line is fine for an LLM
   * consumer to recover the error from.
   */
  head?: string;
  /**
   * The gap between the head and tail (mirroring the foreground
   * `checkToolResultTextLimit`'s "[... N characters elided ...]" note) so the
   * model doesn't mistake the head+tail excerpt for the complete stream.
   */
  elidedChars?: number;
}

/**
 * Format a completed background bash result as a delivery message.
 * Injected into the orchestrator's FollowUpQueue.
 *
 * `stdout.tail`/`stderr.tail` are accumulated from `onStdout`/`onStderr`
 * chunks as the process runs, since `buffer: false` means `result.stdout` is
 * always empty.
 */
export function formatBashDelivery(
  executionId: string,
  command: string,
  wallTimeMs: number,
  result: ExecResult,
  stdout: BashDeliveryStreamExcerpt,
  stderr: BashDeliveryStreamExcerpt,
): string {
  const lines = [
    `<exit-code>${result.exitCode ?? 'unknown'}</exit-code>`,
    `<wall-time>${formatDuration(wallTimeMs)}</wall-time>`,
  ];
  const streams = [
    ['output', stdout],
    ['stderr', stderr],
  ] as const;
  for (const [name, excerpt] of streams) {
    const elidedChars = excerpt.elidedChars ?? 0;
    if (excerpt.head) {
      lines.push(`<${name}-head>${escapeText(excerpt.head)}</${name}-head>`);
      if (elidedChars > 0) {
        lines.push(
          `<${name}-elided>${elidedChars.toLocaleString()} characters elided</${name}-elided>`,
        );
      }
    }
    const tailLines = splitContentLines(excerpt.tail);
    const preview =
      tailLines.length <= OUTPUT_PREVIEW_LINES
        ? excerpt.tail
        : tailLines.slice(-OUTPUT_PREVIEW_LINES).join('\n');
    if (preview) {
      lines.push(`<${name}-preview>${escapeText(preview)}</${name}-preview>`);
    }
  }
  return formatChildRunDelivery(
    {
      tag: DELIVERY_TAG.backgroundResult,
      executionId,
      attributes: [{ name: 'command', value: command }],
    },
    { lines },
  );
}

/**
 * Format a failed background bash result as a delivery message.
 */
export function formatBashError(
  executionId: string,
  command: string,
  err: unknown,
): string {
  return formatChildRunError(
    {
      tag: DELIVERY_TAG.backgroundError,
      executionId,
      attributes: [{ name: 'command', value: command }],
    },
    { message: toErrorMessage(err) },
  );
}
