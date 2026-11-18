/**
 * `texra tasks attach`: one task, live, from the TeXRA service. The client
 * holds no state of its own: the service's `task.watch` frames feed the
 * same frame-driven session view the webviews run (`remoteSessionView`), and this
 * prints what that view finishes. Text output is the task's transcript, one
 * finished row at a time, laid out as the chat TUI prints scrollback; NDJSON
 * output is the task's own rows (not its agents') as `progress` records, in
 * the shape `texra run --output-format ndjson` writes.
 *
 * Attaching never steers the task: it ends when the task reaches a terminal
 * outcome, and an interrupt only detaches this client.
 */
import { stripVTControlCharacters } from 'node:util';

import { Effect, LogLevel, Option, Predicate, Stream } from 'effect';

import { type RunOutcome } from '@texra-ai/harness/schemas';
import { fullTranscriptEntryLayout } from '@cli/chat/tui/panes/transcriptEntryLayout';
import type { EventsFrame } from '@texra/shared/session/sessionFrames';
import type { TaskSummary } from '@texra/controllers/server/protocol';
import type {
  ServiceClient,
  ServiceUnavailable,
} from '@texra/controllers/server/client';
import { watchTask } from '@texra/controllers/server/serviceSession';

import { writeTextStdout } from '../platform/logSinks';
import { writeProgressRow } from './sessionProgressSubscription';
import type { RunView } from '@texra-ai/harness/schemas';

/** How the attached task is printed. */
interface TaskAttachOutput {
  readonly format: 'text' | 'ndjson';
  /** Text layout width. */
  readonly columns: number;
  readonly color: boolean;
}

/** The task's own rows in one frame, as `texra run`'s progress records. */
function writeProgress(
  frame: EventsFrame,
  aggregate: string,
  includeDebugLogs: boolean,
): void {
  for (const input of frame.inputs) {
    if (input._tag !== 'event') continue;
    const { read, event } = input;
    // The listing repeats a run's newest rows; its history and the tail
    // carry each row once.
    if (read === 'listing' || event.aggregateId !== aggregate) continue;
    writeProgressRow(event, includeDebugLogs);
  }
}

/**
 * Follow `task` until it ends, printing it as `output` asks. Returns the
 * task's durable outcome, null when it ended without one.
 */
export const attachTask = Effect.fn('attachTask')(function* (
  client: ServiceClient,
  task: TaskSummary,
  output: TaskAttachOutput,
): Effect.fn.Return<RunOutcome | null, ServiceUnavailable> {
  const includeDebugLogs = yield* LogLevel.isEnabled('Debug');
  const aggregate = task.runId;
  let printed = 0;
  const printFinal = (run: RunView): void => {
    if (output.format !== 'text') return;
    const { rows, finalRows } = run.transcript;
    for (; printed < finalRows; printed += 1) {
      const { lines } = fullTranscriptEntryLayout(
        rows[printed],
        output.columns,
      );
      const text = lines.join('\n');
      writeTextStdout(
        `${output.color ? text : stripVTControlCharacters(text)}\n`,
      );
    }
  };
  const last = yield* watchTask(client, task, (frame) => {
    if (output.format === 'ndjson')
      writeProgress(frame, aggregate, includeDebugLogs);
  }).pipe(
    Stream.map((view) => view.runs.get(task.runId)),
    Stream.filter(Predicate.isNotUndefined),
    Stream.takeUntil((run) => run.outcome !== null),
    Stream.tap((run) => Effect.sync(() => printFinal(run))),
    Stream.runLast,
  );
  return Option.match(last, {
    onNone: () => null,
    onSome: (run) => run.outcome,
  });
});
