/**
 * Formatting utilities for background-bash result delivery.
 *
 * Format helpers convert a completed or failed background bash run into
 * structured XML strings for follow-up delivery to the orchestrator,
 * including a tail/head excerpt of each stream projected from the run's
 * `process.output` rows.
 */

import { formatDelivery } from '@agent/runtime/deliveryEnvelope';
import { DELIVERY_TAG } from '@shared/deliveryTags';

import type { DisplaySessionEvent, ExecResult } from '@shared/schemas';
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
 * Format a completed background bash result as a delivery message.
 * Queued as a follow-up for the orchestrator.
 *
 * Each stream's excerpt is projected from `rows`, the run's display rows
 * once every output row it published is committed: its text is its
 * `process.output` rows in commit order. Past the log cap those rows are
 * the stream's first `recorded` characters, then the last window of what
 * followed; `gaps` says how many characters sit between the two.
 */
export function formatBashDelivery(
  runId: string,
  call: BackgroundBashCall,
  wallTimeMs: number,
  result: ExecResult,
  output: {
    readonly rows: readonly DisplaySessionEvent[];
    /** Per stream, where its rows skip what the cap held back: after its
     *  first `recorded` characters, `elided` are missing (0: none are). */
    readonly gaps: Readonly<
      Record<
        'stdout' | 'stderr',
        { readonly recorded: number; readonly elided: number }
      >
    >;
  },
): string {
  const lines = [
    `<exit-code>${result.exitCode}</exit-code>`,
    // The code above is synthetic when the process timed out or its exit
    // status was lost; say which, so no reader takes it for a real exit.
    ...(result.timedOut ? ['<timed-out>true</timed-out>'] : []),
    ...(result.noExitCode ? ['<no-exit-code>true</no-exit-code>'] : []),
    `<wall-time>${(wallTimeMs / 1000).toFixed(1)}s</wall-time>`,
  ];
  const outputStreams = [
    ['output', 'stdout'],
    ['stderr', 'stderr'],
  ] as const;
  for (const [name, stream] of outputStreams) {
    const text = output.rows
      .flatMap((row) =>
        row.type === 'process.output' && row.stream === stream
          ? [row.text]
          : [],
      )
      .join('');
    const { recorded, elided: missing } = output.gaps[stream];
    // Past the cap the head is cut from what the stream recorded, and its
    // tail is the window its rows end with.
    const [before, tail] =
      missing > 0
        ? [text.slice(0, recorded), text.slice(recorded)]
        : [text, appendTail('', text, BACKGROUND_OUTPUT_TAIL_CHARS)];
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
  return formatDelivery({
    tag: DELIVERY_TAG.backgroundResult,
    runId,
    attributes: callAttributes(call),
    lines,
  });
}

/**
 * Format a failed background bash result as a delivery message.
 */
export function formatBashError(
  runId: string,
  call: BackgroundBashCall,
  err: unknown,
): string {
  return formatDelivery({
    tag: DELIVERY_TAG.backgroundError,
    runId,
    attributes: callAttributes(call),
    message: toErrorMessage(err),
  });
}
