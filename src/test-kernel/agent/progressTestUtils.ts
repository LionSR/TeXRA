import {
  Context,
  Effect,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

// Local imports
import { defineTool } from '@texra-ai/harness';
import {
  type BashRequest,
  type DisplayRow,
  qualifyAggregateId,
  type RequestDecision,
  type RunId,
} from '@texra-ai/harness/schemas';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { aggregateTarget } from '@shared/schemas';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import {
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import type { HostInteractions } from '@texra-ai/harness/host';

/**
 * Loosely-typed recording of host emissions. The recording host flattens the
 * presentation port's typed calls into the same stream as plain `emit` calls,
 * using its own names, so the event vocabulary is a plain string.
 */
type RecordedProgressEvent = {
  event: string;
  payload: unknown;
};

/** A request a run opened, as the fold and every surface read it. */
type OpenedRequest = Extract<DisplayRow, { type: 'request.opened' }>;

type SessionEventReader = Context.Context<SessionLog>;

/**
 * Read the committed prefix using its drain coordinate, including private rows
 * that advance the cursor without appearing on the display plane. The upper
 * bound is the commit the log holds when the read runs; a store that fails
 * the read fails the test.
 */
const readSessionEvents = (
  session: SessionEventReader,
  fromCommit: number,
): Effect.Effect<DisplayRow[]> =>
  Effect.suspend(() => {
    const through = Context.get(session, SessionLog).now();
    if (through <= fromCommit) return Effect.succeed([]);
    return Effect.gen(function* () {
      const drained = yield* SubscriptionRef.make(fromCommit);
      return yield* Context.get(session, SessionLog)
        .tail(fromCommit, drained)
        .pipe(
          Stream.interruptWhen(
            SubscriptionRef.changes(drained).pipe(
              Stream.filter((cursor) => cursor >= through),
              Stream.runHead,
            ),
          ),
          Stream.runCollect,
        );
    }).pipe(Effect.orDie);
  });

/**
 * Read public events committed since this call. Each read captures its own
 * finite upper bound; `qualifyAggregateId` narrows to one stream's facts.
 */
export function recordSessionEvents(
  session: SessionEventReader,
  filter: { readonly aggregateId?: string } = {},
): { readonly read: Effect.Effect<DisplayRow[]> } {
  const start = Context.get(session, SessionLog).now();
  return {
    read: Effect.map(readSessionEvents(session, start), (events) =>
      filter.aggregateId === undefined
        ? events
        : events.filter((event) => event.aggregateId === filter.aggregateId),
    ),
  };
}

/**
 * A host that records what the runtime presents to it. The port answers
 * nothing (ruling A9-3): a request a run opens is a `request.opened` row, so
 * a test that must answer one uses {@link decideRequest} or
 * {@link autoDecideRequests}.
 */
export function createRecordingHost(): {
  events: RecordedProgressEvent[];
  interactions: HostInteractions;
} {
  const events: RecordedProgressEvent[] = [];
  const interactions: HostInteractions = {
    emit: (event, payload) => {
      events.push({ event, payload });
    },
  };
  return { events, interactions };
}

/**
 * Answer one open request the way a surface's `request.decide` does: the
 * decision lands as the run's `request.decided` row, which is what the waiting
 * run and every surface read.
 */
export const decideRequest = (
  session: Context.Context<SessionServices>,
  request: { readonly runId: RunId; readonly requestId: string },
  decision: RequestDecision,
): Effect.Effect<void> =>
  publishTestRows(session, [
    {
      type: 'request.decided',
      aggregateId: qualifyAggregateId('run', request.runId),
      requestId: request.requestId,
      decision,
    },
  ]);

/**
 * Answer every request a session opens from this call on, until the calling
 * scope closes. `decide` sees the `request.opened` row and returns the
 * decision, or null to leave the request pending — which is how a test
 * exercises a run parked on an unanswered request. `opened` lists every
 * request the session opened meanwhile.
 */
export const autoDecideRequests = (
  session: Context.Context<SessionServices>,
  decide: (request: OpenedRequest) => RequestDecision | null,
): Effect.Effect<{ readonly opened: OpenedRequest[] }, never, Scope.Scope> =>
  Effect.suspend(() => {
    const opened: OpenedRequest[] = [];
    const log = Context.get(session, SessionLog);
    return Stream.runForEach(
      log
        .tail(log.now())
        .pipe(
          Stream.filter(
            (event): event is OpenedRequest => event.type === 'request.opened',
          ),
        ),
      (event) =>
        Effect.gen(function* () {
          opened.push(event);
          const decision = decide(event);
          if (decision === null) return;
          const target = aggregateTarget(event.aggregateId);
          if (target.kind !== 'run') return;
          yield* decideRequest(
            session,
            { runId: target.id, requestId: event.requestId },
            decision,
          );
        }),
    ).pipe(
      Effect.forkScoped({ startImmediately: true }),
      Effect.as({ opened }),
    );
  });

/** Publish the run's existence fact when the view has yet to hold it. */
async function ensureRunStart(
  session: Context.Context<SessionServices>,
  runId: RunId,
): Promise<void> {
  // A start already queued has yet to reach the view, and a second one is
  // refused by the substrate.
  await Effect.runPromise(Context.get(session, SessionLog).settled);
  if (Context.get(session, SessionViewAccess).run(runId) !== undefined) return;
  await Effect.runPromise(publishTestRunStart(session, runId));
}

/** Fold a run to its running phase from the activation row that carries it. */
export async function seedActiveRun(
  session: Context.Context<SessionServices>,
  runId: RunId,
): Promise<void> {
  await ensureRunStart(session, runId);
  await Effect.runPromise(
    publishTestRows(session, [
      { type: 'run.activate', aggregateId: qualifyAggregateId('run', runId) },
    ]),
  );
}

/** A tool whose calls the run's command grant answers, as the shell's do;
 *  its body only reports that it ran. */
export const commandTool = defineTool({
  name: 'command',
  description: 'Run a command.',
  schema: Schema.Struct({ command: Schema.String }),
  guard: {
    command: { text: ({ command }) => command, grant: 'bash' },
  },
  execute: ({ command }) => Effect.succeed(`ran ${command}`),
});

/** The bash permission payload a `request.opened` carries. */
export function bashApprovalRequest(request: {
  readonly command: string;
  readonly cwd?: string;
  readonly runId?: RunId;
}): BashRequest {
  return {
    requestId: `bash-${crypto.randomUUID()}`,
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    allowBypass: true,
    runId: request.runId ?? '',
  };
}
