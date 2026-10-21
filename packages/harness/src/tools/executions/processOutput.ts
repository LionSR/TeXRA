/**
 * `/executions/{id}/output`: a background command's durable `log` rows
 * projected into display lines, and the windowed read that serves them.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  ToolError,
  type RunId,
  type SessionEvent,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import {
  BASH_BACKGROUND_LOG_CAP_CHARS,
  type BackgroundBashOutputSource,
  getBackgroundBashOutputSource,
} from '@shared/toolUse';
import { executed } from '@tools/core/result';
import { describeRunNotice, formatRunStatus } from '../executionFormatters';

/** Lines returned by /executions/{id}/output when no view_range is given. */
const OUTPUT_TAIL_LINES = 200;

/** Hard ceiling on lines a single /output read returns, view_range included. */
const OUTPUT_MAX_LINES = 1_000;

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
function projectProcessOutput(
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

/**
 * stdout/stderr of a background command, projected from the transcript log
 * its child run already writes (`createChildRun` in `tools/bash.ts`).
 *
 * This is the only route readable *while the command runs*: `/report` and
 * `/result` are written at completion, and the completion follow-up carries
 * only a 20-line preview, so without this the middle of a long build log is
 * unreachable even after the run ends. Restricted to process runs —
 * an agent run's rows are a model transcript, which `/conversation` already
 * renders properly.
 */
export const showOutput = Effect.fn('ExecutionsTool.showOutput')(function* (
  session: SessionHandle,
  runId: RunId,
  viewRange?: [number, number],
) {
  const run = session.view.run(runId);
  if (run === undefined) {
    return yield* Effect.fail(new ToolError(`Run not found: ${runId}`));
  }
  if (run.identity.kind !== 'process') {
    return executed(
      `/executions/${runId}/output is only available for background commands (bash with run_in_background). ` +
        `Use /executions/${runId}/conversation for an agent run's message history.`,
    );
  }

  // The status is the row read before the transcript: the session has one
  // publisher, so a run the view shows terminal has every output row
  // committed, and the log read after it is complete. A status read after
  // the log could call finished a log that misses the final chunks.
  const { lines, chars } = projectProcessOutput(
    yield* session.log.display(runId).pipe(Effect.orDie),
  );
  // The footer states the same reading as the header, and both come from
  // the fold: "no handle in this process" alone never justifies calling a
  // command finished, and a run whose owner is gone reads as interrupted
  // rather than as one that recorded how it ended.
  const lead = isTerminalOutcomePhase(run.status)
    ? 'finished:'
    : (describeRunNotice(run) ??
      `still running: re-read for more output, or use action='wait' on /executions/${runId} to block until it finishes;`);
  const footer = `[${lead} this is the retained log; /executions/${runId}/report has the result summary]`;
  const out: string[] = [
    `Output for ${runId} (process, ${formatRunStatus(run)}): ${chars.toLocaleString()} retained transcript chars; command-output cap ${BASH_BACKGROUND_LOG_CAP_CHARS.toLocaleString()} chars, ${lines.length.toLocaleString()} lines.`,
  ];

  if (lines.length === 0) {
    out.push('', footer);
    return executed(out.join('\n'));
  }
  out.push('Lines are in arrival order; `err:` marks one written to stderr.');

  // Default to the tail, where a live build's news is; a view_range window
  // is clamped so a wide request still can't return an unbounded log.
  const first =
    viewRange?.[0] ?? Math.max(lines.length - OUTPUT_TAIL_LINES, 0) + 1;
  const requestedLast = Math.min(viewRange?.[1] ?? lines.length, lines.length);
  const last = Math.min(requestedLast, first + OUTPUT_MAX_LINES - 1);

  if (first > last) {
    out.push(
      `No lines in the requested range; the log has ${lines.length} lines.`,
      '',
      footer,
    );
    return executed(out.join('\n'));
  }

  let hint = '';
  if (last < requestedLast) {
    hint = ` (capped at ${OUTPUT_MAX_LINES} lines per read; continue from view_range: [${last + 1}, …])`;
  } else if (!viewRange && first > 1) {
    hint = ` (the last ${OUTPUT_TAIL_LINES} by default; use view_range to page earlier ones)`;
  }
  out.push(
    `Showing lines ${first}-${last} of ${lines.length}${hint}.`,
    '',
    lines.slice(first - 1, last).join('\n'),
    '',
    footer,
  );

  return executed(
    out.join('\n'),
    `Read lines ${first}-${last} of /executions/${runId}/output`,
  );
});
