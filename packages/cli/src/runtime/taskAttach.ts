/**
 * `texra tasks attach`: one task, live, from the TeXRA service. The client
 * holds no state of its own: the service's `task.watch` frames feed the
 * same frame-driven fold the webviews run (`WebviewSessions`), and this
 * prints what that fold settles. Text output is the task's transcript, one
 * settled row at a time, laid out as the chat TUI prints scrollback; NDJSON
 * output is the task's own rows (not its agents') as `progress` records, in
 * the shape `texra run --output-format ndjson` writes.
 *
 * Attaching never steers the task: it ends when the task reaches a terminal
 * outcome, and an interrupt only detaches this client.
 */
import {
  Data,
  Effect,
  Fiber,
  LogLevel,
  Option,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import stripAnsi from 'strip-ansi';

import { fullTranscriptEntryLayout } from '@cli/chat/tui/panes/transcriptEntryLayout';
import { WebviewSessions } from '@controllers/session/webviewSessionLayer';
import type { ServiceClient } from '@controllers/server/client';
import type { TaskSummary } from '@controllers/server/protocol';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { aggregateId, type RunOutcome } from '@shared/schemas';
import type { EventsFrame } from '@shared/session/sessionFrames';
import type { RunView } from '@shared/session/sessionView';

import { writeNdjsonStdout, writeTextStdout } from './logSinks';

/** The subscription port of this client's fold. */
const ATTACH_PORT = 'attach';

/** How the attached task is printed. */
export interface TaskAttachOutput {
  readonly format: 'text' | 'ndjson';
  /** Text layout width. */
  readonly columns: number;
  readonly color: boolean;
}

/** The service stopped sending the task before it ended. */
export class TaskWatchEnded extends Data.TaggedError('TaskWatchEnded')<{
  readonly runId: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `The TeXRA service stopped sending task ${this.runId}: ${this.reason}`;
  }
}

/** The task's own rows in one frame, as `texra run`'s progress records. */
function writeProgress(
  frame: EventsFrame,
  aggregate: string,
  includeDebugLogs: boolean,
): void {
  for (const { read, event } of frame.events) {
    // The listing repeats a run's newest rows; its history and the tail
    // carry each row once.
    if (read === 'listing' || event.aggregateId !== aggregate) continue;
    // A debug log row is a diagnostic: only `--verbose` prints it, as in
    // `texra run`'s projection.
    if (!includeDebugLogs && event.type === 'log' && event.level === 'debug')
      continue;
    const { type, ...payload } = event;
    writeNdjsonStdout({
      kind: 'progress',
      event: type,
      ts: new Date().toISOString(),
      payload,
    });
  }
}

/**
 * Follow `task` until it ends, printing it as `output` asks. Returns the
 * task's durable outcome, null when it ended without one.
 */
export const attachTask = Effect.fn('attachTask')(
  function* (
    client: ServiceClient,
    task: TaskSummary,
    output: TaskAttachOutput,
  ): Effect.fn.Return<
    RunOutcome | null,
    TaskWatchEnded,
    WebviewSessions | Scope.Scope
  > {
    const includeDebugLogs = yield* LogLevel.isEnabled('Debug');
    const graph = yield* WebviewSessions.open(task.workspace);
    const aggregate = aggregateId('run', task.runId);
    const aggregates = [{ id: aggregate, fromSeq: 0 }];
    const generation = 1;
    // Begin the generation and name the transcript before the first frame,
    // as a webview shell does before it posts its `Subscribe`.
    yield* graph.frames.begin(generation);
    yield* graph.subscriptions.set(ATTACH_PORT, aggregates);
    const { debug } = yield* SubscriptionRef.get(graph.view.ref);
    const feeding = yield* client['task.watch']({
      workspace: task.workspace,
      subscribe: {
        kind: 'subscribe',
        session: task.workspace,
        generation,
        debug,
        cursor: 0,
        aggregates,
      },
    }).pipe(
      Stream.runForEach((frame) =>
        Effect.sync(() => {
          if (output.format === 'ndjson')
            writeProgress(frame, aggregate, includeDebugLogs);
        }).pipe(Effect.andThen(graph.frames.feed(frame))),
      ),
      Effect.forkScoped,
    );

    let printed = 0;
    const printSettled = (run: RunView, ended: boolean): void => {
      if (output.format !== 'text') return;
      const { rows, settledRows } = run.transcript;
      const until = ended ? rows.length : settledRows;
      for (; printed < until; printed += 1) {
        const { lines } = fullTranscriptEntryLayout(
          rows[printed],
          output.columns,
        );
        const text = lines.join('\n');
        writeTextStdout(`${output.color ? text : stripAnsi(text)}\n`);
      }
    };
    const follow = graph.view.changes.pipe(
      Stream.map((view) => view.runs.get(task.runId)),
      Stream.filter((run): run is RunView => run !== undefined),
      Stream.takeUntil((run) => isTerminalOutcomePhase(run.status)),
      Stream.tap((run) =>
        Effect.sync(() =>
          printSettled(run, isTerminalOutcomePhase(run.status)),
        ),
      ),
      Stream.runLast,
      Effect.map((last) =>
        Option.match(last, {
          onNone: () => null,
          onSome: (run) => run.durableOutcome,
        }),
      ),
    );
    // The watch only ends when the service does: the task did not end here.
    const watchEnded = Fiber.join(feeding).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.fail(
            new TaskWatchEnded({ runId: task.runId, reason: error.message }),
          ),
        onSuccess: () =>
          Effect.fail(
            new TaskWatchEnded({
              runId: task.runId,
              reason: 'the service closed the watch.',
            }),
          ),
      }),
    );
    return yield* Effect.raceFirst(follow, watchEnded);
  },
  Effect.scoped,
  Effect.provide(WebviewSessions.layerNoDeps),
);
