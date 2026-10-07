/**
 * Projection of a background command's durable `log` rows into the display
 * lines `/executions/{id}/output` serves, plus the window bounds that read
 * applies.
 */

// Local imports
import { LOG_LEVELS, MESSAGE_TYPES, type SessionEvent } from '@shared/schemas';
import {
  type BackgroundBashOutputSource,
  getBackgroundBashOutputSource,
} from '@shared/toolUse';

/** Lines returned by /executions/{id}/output when no view_range is given. */
export const OUTPUT_TAIL_LINES = 200;

/** Hard ceiling on lines a single /output read returns, view_range included. */
export const OUTPUT_MAX_LINES = 1_000;

/** Marks a projected line that the command wrote to stderr. */
const OUTPUT_STDERR_PREFIX = 'err: ';

/**
 * Line break in captured terminal output. A bare CR counts: progress bars
 * (curl, pip, docker) redraw with `\r` and no newline, so splitting on LF
 * alone would collapse a whole build's progress into one enormous "line" and
 * hand the caller the entire log however small the requested window was.
 */
const OUTPUT_LINE_BREAK = /\r\n|\r|\n/;

interface ProcessOutputProjection {
  readonly lines: readonly string[];
  readonly chars: number;
}

/**
 * Flatten a background command's run rows into display lines.
 *
 * Only plain `log` rows count: stages, usage and every row with a typed
 * `messageType` are run bookkeeping, not command output, and a debug-level
 * line is a diagnostic. Tagged stdout/stderr chunks stay in commit order and
 * concatenate only while their source remains compatible, so chunk-split
 * lines are reconstructed without crossing a stream switch. Untagged lifecycle
 * rows flush any pending command fragment and render standalone.
 */
export function projectProcessOutput(
  events: readonly SessionEvent[],
): ProcessOutputProjection {
  const lines: string[] = [];
  let chars = 0;
  let pendingText = '';
  let pendingSource: BackgroundBashOutputSource | undefined;

  const emitText = (text: string, stderr: boolean): void => {
    // A trailing break terminates the last line rather than opening an empty
    // one; blank lines inside the text still survive the split.
    const normalized = text.replace(/\r\n$|[\r\n]$/, '');
    for (const line of normalized.split(OUTPUT_LINE_BREAK)) {
      lines.push(stderr ? `${OUTPUT_STDERR_PREFIX}${line}` : line);
    }
  };
  const flushPending = (): void => {
    if (pendingText && pendingSource) {
      emitText(pendingText, pendingSource === 'stderr');
    }
    pendingText = '';
    pendingSource = undefined;
  };

  for (const event of events) {
    if (event.type !== 'log' || event.level === LOG_LEVELS.DEBUG) continue;
    if ((event.messageType ?? MESSAGE_TYPES.DEFAULT) !== MESSAGE_TYPES.DEFAULT)
      continue;
    const text = event.message;
    if (!text) continue;

    chars += text.length;
    const source = getBackgroundBashOutputSource(event.data);
    if (!source) {
      flushPending();
      emitText(
        text,
        event.level === LOG_LEVELS.WARN || event.level === LOG_LEVELS.ERROR,
      );
      continue;
    }

    if (pendingSource && pendingSource !== source) flushPending();
    pendingSource = source;
    pendingText += text;
  }
  flushPending();

  return { lines, chars };
}
