/**
 * What a background bash run delivers to the orchestrator: its exit and a
 * tail/head excerpt of each stream projected from the run's
 * `process.output` rows, or its failure.
 */

import { DELIVERY_FAMILY } from '@shared/deliveryTags';

import type {
  ChildRunDelivery,
  DisplayRow,
  ProcessExit,
} from '@shared/schemas';
import { escapeText } from '@shared/utils/xmlEscape';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { appendTail, headTail } from '@utils/text/appendTail';
import { splitContentLines } from '@utils/text/stringUtils';

/** Last N lines of output for the delivery preview. */
const OUTPUT_PREVIEW_LINES = 20;
/**
 * Each stream's excerpt: `tail` is the trailing window the preview is cut
 * from, and what the writer keeps of a stream past the log cap (its rows end
 * with this window); `head` is shown beside it once a stream outgrows it, at
 * roughly the foreground head:tail ratio, since a long background build's
 * first fatal error tends to sit near the top of the log. The head is emitted
 * as-is and may end mid-line: a char-capped excerpt, not a line-bounded
 * preview. The gap between head and tail is stated so the model doesn't
 * mistake the excerpt for the complete stream.
 */
export const BACKGROUND_OUTPUT = Object.freeze({ head: 1_000, tail: 12_000 });

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
  exit: ProcessExit,
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
    // Past the cap, the row marking the gap starts the stream's last window.
    const window = headTail(BACKGROUND_OUTPUT);
    for (const chunk of chunks) {
      if (chunk.elided !== undefined) window.skip(chunk.elided);
      window.append(chunk.text);
    }
    const { head, tail, elided } = window.read();
    const shown = appendTail('', head + tail, BACKGROUND_OUTPUT.tail);
    // A head only when the tail window dropped earlier text: otherwise it
    // holds the whole stream and a head would repeat it.
    if (elided > 0 || shown.length < head.length + tail.length) {
      if (head) lines.push(`<${name}-head>${escapeText(head)}</${name}-head>`);
      if (elided > 0) {
        lines.push(
          `<${name}-elided>${elided.toLocaleString()} characters elided</${name}-elided>`,
        );
      }
    }
    const excerpt = elided > 0 ? tail : shown;
    const tailLines = splitContentLines(excerpt);
    const preview =
      tailLines.length <= OUTPUT_PREVIEW_LINES
        ? excerpt
        : tailLines.slice(-OUTPUT_PREVIEW_LINES).join('\n');
    if (preview) {
      lines.push(`<${name}-preview>${escapeText(preview)}</${name}-preview>`);
    }
  }
  return {
    family: DELIVERY_FAMILY.background,
    runId,
    attributes: callAttributes(call),
    exit,
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
