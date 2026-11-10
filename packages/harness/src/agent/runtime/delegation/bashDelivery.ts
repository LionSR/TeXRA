/**
 * What a background bash run delivers to the orchestrator: its exit and a
 * tail/head excerpt of each stream projected from the run's
 * `process.output` rows, or its failure.
 */

import { DELIVERY_FAMILY } from '@shared/deliveryTags';

import type { ChildRunDelivery, DisplayRow, ExecResult } from '@shared/schemas';
import { escapeText } from '@shared/utils/xmlEscape';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { appendHead, appendTail } from '@utils/text/appendTail';
import { splitContentLines } from '@utils/text/stringUtils';

/** Last N lines of output for the delivery preview. */
const OUTPUT_PREVIEW_LINES = 20;
/**
 * The trailing window of each stream the preview is cut from, and what the
 * writer keeps of a stream past the log cap: its rows end with this window.
 */
export const BACKGROUND_OUTPUT_TAIL_CHARS = 12_000;
/**
 * Small head budget shown beside the tail once a stream outgrows it, at
 * roughly the foreground head:tail ratio. A long background build's first
 * fatal error tends to sit near the top of the log, well before the tail's
 * trailing window. The head is emitted as-is and may end mid-line: a
 * char-capped excerpt, not a line-bounded preview. The gap between head and
 * tail is stated (mirroring the foreground `checkToolResultTextLimit`'s
 * "[... N characters elided ...]" note) so the model doesn't mistake the
 * excerpt for the complete stream.
 */
export const BACKGROUND_OUTPUT_HEAD_CHARS = 1_000;

/** The call a background command came from: what it runs, and the
 *  model's short description of it, which names it in the transcript. */
export interface BackgroundBashCall {
  readonly command: string;
  readonly description?: string | null;
}

const callAttributes = ({ command, description }: BackgroundBashCall) => [
  { name: 'command', value: command },
  ...(description ? [{ name: 'description', value: description }] : []),
];

/**
 * A completed background bash result's delivery, queued as a follow-up for
 * the orchestrator.
 *
 * Each stream's excerpt is projected from `rows`, the run's display rows
 * once every output row it published is committed: its text is its
 * `process.output` rows in commit order. Past the log cap, the row marking
 * the gap (`elided`) starts the stream's last window, and the rows before
 * it are the stream's first characters.
 */
export function bashResultDelivery(
  runId: string,
  call: BackgroundBashCall,
  wallTimeMs: number,
  result: ExecResult,
  rows: readonly DisplayRow[],
): ChildRunDelivery {
  const lines: string[] = [];
  const outputStreams = [
    ['output', 'stdout'],
    ['stderr', 'stderr'],
  ] as const;
  for (const [name, stream] of outputStreams) {
    const chunks = rows.flatMap((row) =>
      row.type === 'process.output' && row.stream === stream ? [row] : [],
    );
    const gap = chunks.findIndex((chunk) => chunk.elided !== undefined);
    const textOf = (from: number, to?: number) =>
      chunks
        .slice(from, to)
        .map((chunk) => chunk.text)
        .join('');
    const text = textOf(0);
    const missing = gap < 0 ? 0 : (chunks[gap]?.elided ?? 0);
    // Past the cap the head is cut from the rows before the gap, and the
    // tail is the window the gap's row starts.
    const [before, tail] =
      gap < 0
        ? [text, appendTail('', text, BACKGROUND_OUTPUT_TAIL_CHARS)]
        : [textOf(0, gap), textOf(gap)];
    // A head only when the tail dropped earlier text: otherwise the tail
    // holds the whole stream and a head would repeat it.
    if (missing > 0 || text.length > tail.length) {
      const head = appendHead('', before, BACKGROUND_OUTPUT_HEAD_CHARS);
      if (head) lines.push(`<${name}-head>${escapeText(head)}</${name}-head>`);
      const elidedChars = text.length - head.length - tail.length + missing;
      if (elidedChars > 0) {
        lines.push(
          `<${name}-elided>${elidedChars.toLocaleString()} characters elided</${name}-elided>`,
        );
      }
    }
    const tailLines = splitContentLines(tail);
    const preview =
      tailLines.length <= OUTPUT_PREVIEW_LINES
        ? tail
        : tailLines.slice(-OUTPUT_PREVIEW_LINES).join('\n');
    if (preview) {
      lines.push(`<${name}-preview>${escapeText(preview)}</${name}-preview>`);
    }
  }
  return {
    family: DELIVERY_FAMILY.background,
    runId,
    attributes: callAttributes(call),
    exit: {
      code: result.exitCode,
      timedOut: result.timedOut,
      noExitCode: result.noExitCode === true,
    },
    wallTime: `${(wallTimeMs / 1000).toFixed(1)}s`,
    lines,
  };
}

/** A failed background bash run's delivery. */
export function bashErrorDelivery(
  runId: string,
  call: BackgroundBashCall,
  err: unknown,
): ChildRunDelivery {
  return {
    family: DELIVERY_FAMILY.background,
    runId,
    attributes: callAttributes(call),
    message: toErrorMessage(err),
  };
}
