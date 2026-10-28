import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';

// Local imports
import {
  SessionHostInteractions,
  type HostInteractions,
} from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  qualifyAggregateId,
  aggregateTarget,
  type BashPermission,
  type DisplaySessionEvent,
  type RequestDecision,
  type RunId,
} from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import {
  prepareToolEditApprovalPrompt,
  type ToolEditApprovalRequest,
} from '@tools/approval/toolEditApproval';
import { workspaceRelativePath } from '@utils/files/workspaceFS';

/**
 * Loosely-typed recording of host emissions. The recording host flattens the
 * presentation port's typed calls into the same stream as plain `emit` calls,
 * using its own names, so the event vocabulary is a plain string.
 */
type RecordedProgressEvent = {
  event: string;
  payload: unknown;
};

interface RecordingProgressSink {
  emit(event: string, payload: unknown): void;
}

/** A request a run opened, as the fold and every surface read it. */
type OpenedRequest = Extract<DisplaySessionEvent, { type: 'request.opened' }>;

type SessionEventReader = Pick<SessionHandle, 'log'>;

/**
 * Read the committed prefix using its drain coordinate, including private rows
 * that advance the cursor without appearing on the display plane.
 */
async function readSessionEvents(
  session: SessionEventReader,
  fromCommit = 0,
): Promise<DisplaySessionEvent[]> {
  const through = session.log.now();
  if (through <= fromCommit) return [];
  return testRuntime().runPromise(
    Effect.gen(function* () {
      const drained = yield* SubscriptionRef.make(fromCommit);
      return yield* session.log.tail(fromCommit, drained).pipe(
        Stream.interruptWhen(
          SubscriptionRef.changes(drained).pipe(
            Stream.filter((cursor) => cursor >= through),
            Stream.runHead,
          ),
        ),
        Stream.runCollect,
      );
    }),
  );
}

/**
 * Read public events committed since this call. Each read captures its own
 * finite upper bound; `qualifyAggregateId` narrows to one stream's facts.
 */
export function recordSessionEvents(
  session: SessionEventReader,
  filter: { readonly aggregateId?: string } = {},
): { readonly read: () => Promise<DisplaySessionEvent[]> } {
  const start = session.log.now();
  return {
    async read() {
      const events = await readSessionEvents(session, start);
      return filter.aggregateId === undefined
        ? events
        : events.filter((event) => event.aggregateId === filter.aggregateId);
    },
  };
}

/** The events (or drafts) of one arm. */
export function eventsOfType<
  E extends { readonly type: string },
  T extends E['type'],
>(events: readonly E[], type: T): Array<Extract<E, { type: T }>> {
  return events.filter(
    (event): event is Extract<E, { type: T }> => event.type === type,
  );
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
  host: SessionHostInteractions & RecordingProgressSink;
} {
  const events: RecordedProgressEvent[] = [];
  const interactions: HostInteractions = {
    emit: (event, payload) => {
      events.push({ event, payload });
    },
    presentToolEdit: (request) =>
      events.push({ event: 'presentToolEdit', payload: request.permission }),
  };
  const host = new SessionHostInteractions() as SessionHostInteractions &
    RecordingProgressSink;
  Effect.runSync(host.use(interactions));
  return { events, interactions, host };
}

/**
 * Answer one open request the way a surface's `request.decide` does: the
 * decision lands as the run's `request.decided` row, which is what the waiting
 * run and every surface read.
 */
export function decideRequest(
  session: SessionHandle,
  request: { readonly runId: RunId; readonly requestId: string },
  decision: RequestDecision,
): void {
  publishTestRows(session, [
    {
      type: 'request.decided',
      aggregateId: qualifyAggregateId('run', request.runId),
      requestId: request.requestId,
      decision,
    },
  ]);
}

/**
 * Answer every request a session opens from this call on. `decide` sees the
 * `request.opened` row and returns the decision, or null to leave the request
 * pending — which is how a test exercises a run parked on an unanswered
 * request.
 */
export function autoDecideRequests(
  session: SessionHandle,
  decide: (request: OpenedRequest) => RequestDecision | null,
): { readonly opened: OpenedRequest[]; readonly detach: () => void } {
  const opened: OpenedRequest[] = [];
  const fiber = testRuntime().runFork(
    Stream.runForEach(
      session.log
        .tail(session.log.now())
        .pipe(
          Stream.filter(
            (event): event is OpenedRequest => event.type === 'request.opened',
          ),
        ),
      (event) =>
        Effect.sync(() => {
          opened.push(event);
          const decision = decide(event);
          if (decision === null) return;
          const target = aggregateTarget(event.aggregateId);
          if (target.kind !== 'run') return;
          decideRequest(
            session,
            { runId: target.id, requestId: event.requestId },
            decision,
          );
        }),
    ),
  );
  return {
    opened,
    detach: () => {
      testRuntime().runFork(Fiber.interrupt(fiber));
    },
  };
}

/** Publish the run's existence fact when the view has yet to hold it. */
async function ensureRunStart(
  session: SessionHandle,
  runId: RunId,
): Promise<void> {
  // A start already queued has yet to reach the view, and a second one is
  // refused by the substrate.
  await Effect.runPromise(session.log.settled);
  if (session.view.run(runId) !== undefined) return;
  publishTestRunStart(session, runId);
  await Effect.runPromise(session.log.settled);
}

/** Fold a run to its running phase from the activation row that carries it. */
export async function seedActiveRun(
  session: SessionHandle,
  runId: RunId,
): Promise<void> {
  await ensureRunStart(session, runId);
  publishTestRows(session, [
    { type: 'run.activate', aggregateId: qualifyAggregateId('run', runId) },
  ]);
  await Effect.runPromise(session.log.settled);
}

/**
 * An isolated session for node tests, with the given host interactions
 * attached: a test hands this session to run-scoped code, whose
 * `session.interactions` (presentation) and `session.approvals` (bypass
 * state, queues) reads reach the owners attached here. A session's facts are
 * read back with {@link recordSessionEvents}. Passing another session's
 * `SessionHostInteractions` makes it this session's owner too, so a
 * recording host can be shared across the sessions of one test.
 */
export const sessionWithInteractions = Effect.fn('sessionWithInteractions')(
  function* (
    interactions:
      | HostInteractions
      | SessionHostInteractions
      | Pick<SessionHostInteractions, 'emit'>
      | undefined,
  ) {
    const session = yield* createTestSession();
    if (interactions instanceof SessionHostInteractions) {
      // The session's own approvals stay: they are already bound to its
      // `publishApprovalPolicy`, the one channel bypass state travels.
      Object.assign(session, { interactions });
      return session;
    }
    if (interactions) yield* session.interactions.use(interactions);
    return session;
  },
);

/** The bash permission payload a `request.opened` carries. */
export function bashApprovalRequest(request: {
  readonly command: string;
  readonly cwd?: string;
  readonly runId?: RunId;
}): BashPermission {
  return {
    requestId: `bash-${crypto.randomUUID()}`,
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    allowBypass: true,
    runId: request.runId ?? '',
  };
}

/** A tool-edit request carrying the prompt the tool boundary prepares. */
export const toolEditApprovalRequest = Effect.fn('toolEditApprovalRequest')(
  function* (
    request: Parameters<typeof prepareToolEditApprovalPrompt>[1]['request'],
  ) {
    const session = yield* sessionWithInteractions(undefined);
    const { permission, hunks, firstChangedLine } =
      prepareToolEditApprovalPrompt(session, {
        requestId: `approval-${crypto.randomUUID()}`,
        request,
        relativePath: workspaceRelativePath(
          session.roots.workspace,
          request.path,
        ),
      });
    return {
      ...request,
      roots: session.roots,
      permission,
      hunks,
      firstChangedLine,
    } satisfies ToolEditApprovalRequest;
  },
);
