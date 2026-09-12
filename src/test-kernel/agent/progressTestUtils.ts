import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';

// Local imports
import type { AgentEvent, AgentTrace } from '@agent/trace';
import {
  SessionHostInteractions,
  type HostInteractions,
} from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import { effectRuntime } from '@platform/processRuntime';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  AgentCategory,
  emptyRunEndOutput,
  type ActiveChildInfo,
  type BashPermission,
  type DisplaySessionEvent,
  type RequestDecision,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  prepareToolEditApprovalPrompt,
  type ToolEditApprovalRequest,
} from '@tools/approval/toolEditApproval';
import { generateShortId } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';

/**
 * Loosely-typed recording of host emissions. The recording host flattens the
 * presentation port's typed calls into the same stream as plain `emit` calls,
 * using its own names, so the event vocabulary is a plain string.
 */
export type RecordedProgressEvent = {
  event: string;
  payload: unknown;
};

export interface RecordingProgressSink {
  emit(event: string, payload: unknown): void;
}

/** A request a run opened, as the fold and every surface read it. */
type OpenedRequest = Extract<DisplaySessionEvent, { type: 'request.opened' }>;

type SessionEventReader = Pick<SessionHandle, 'events' | 'now'>;

/**
 * Read the committed prefix using its drain coordinate, including private rows
 * that advance the cursor without appearing on the display plane.
 */
async function readSessionEvents(
  session: SessionEventReader,
  fromCommit = 0,
): Promise<DisplaySessionEvent[]> {
  const through = session.now();
  if (through <= fromCommit) return [];
  return effectRuntime().runPromise(
    Effect.gen(function* () {
      const drained = yield* SubscriptionRef.make(fromCommit);
      return yield* session.events.all(fromCommit, drained).pipe(
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
 * finite upper bound; `aggregateId` narrows to one stream's facts.
 */
export function recordSessionEvents(
  session: SessionEventReader,
  filter: { readonly aggregateId?: string } = {},
): { readonly read: () => Promise<DisplaySessionEvent[]> } {
  const start = session.now();
  return {
    async read() {
      const events = await readSessionEvents(session, start);
      return filter.aggregateId === undefined
        ? events
        : events.filter((event) => event.aggregateId === filter.aggregateId);
    },
  };
}

/** Every child roster a registry tells its listeners from this call on. */
export function recordChildRosters(
  registry: Pick<SessionHandle['runs'], 'onChildActivity'>,
): {
  readonly rosters: Array<{
    readonly parentRunId: RunId;
    readonly items: readonly ActiveChildInfo[];
  }>;
} {
  const rosters: Array<{
    readonly parentRunId: RunId;
    readonly items: readonly ActiveChildInfo[];
  }> = [];
  registry.onChildActivity((parentRunId, items) => {
    rosters.push({ parentRunId, items });
  });
  return { rosters };
}

/** Every stream whose follow-up queue reports input sent from this call on. */
export function recordFollowUpsSent(
  session: Pick<SessionHandle, 'followUps'>,
): { readonly sent: RunId[] } {
  const sent: RunId[] = [];
  session.followUps.onSent((runId) => sent.push(runId));
  return { sent };
}

/** Every event a run trace emits from this call on. */
export function recordTraceEvents(trace: AgentTrace): {
  readonly events: AgentEvent[];
} {
  const events: AgentEvent[] = [];
  trace.subscribe((event) => events.push(event));
  return { events };
}

export function traceEventsOfType<T extends AgentEvent['type']>(
  events: readonly AgentEvent[],
  type: T,
): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: T }> => event.type === type,
  );
}

/**
 * Let every reader of a session's plane (`events.all`, the fold fiber)
 * deliver what was published before this call: the readers run on the
 * process runtime's scheduler, which drains on a macrotask.
 */
export async function settleSessionEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
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
    setApprovalBypassState: (update) =>
      events.push({ event: 'setApprovalBypassState', payload: update }),
    presentToolEdit: (request) =>
      events.push({ event: 'presentToolEdit', payload: request.permission }),
  };
  const host = sessionWithInteractions(undefined)
    .interactions as SessionHostInteractions & RecordingProgressSink;
  host.use(interactions);
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
  session.publish([
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
  const fiber = effectRuntime().runFork(
    Stream.runForEach(
      session.events
        .all(session.now())
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
      effectRuntime().runFork(Fiber.interrupt(fiber));
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
  await session.settlePublications();
  if (session.runView(runId) !== undefined) return;
  publishTestRunStart(session, runId);
  await session.settlePublications();
}

/**
 * Fold a run to its running phase from the rows that carry it (one run model,
 * 3.3): a first activation is starting, a second is the resume
 * `RunView.substate` reports (ruling A9-1).
 */
export async function seedActiveRun(
  session: SessionHandle,
  runId: RunId,
  options: { readonly resuming?: boolean } = {},
): Promise<void> {
  await ensureRunStart(session, runId);
  const activations = options.resuming === true ? 2 : 1;
  for (let index = 0; index < activations; index += 1) {
    session.publish([
      {
        type: 'run.activate',
        aggregateId: qualifyAggregateId('run', runId),
        category: AgentCategory.ToolUse,
      },
    ]);
    await session.settlePublications();
  }
}

/** Fold a run to a terminal phase from its `run.end` row, the one fact that
 *  carries it. */
export async function seedTerminalRun(
  session: SessionHandle,
  runId: RunId,
  outcome: RunOutcome,
): Promise<void> {
  await ensureRunStart(session, runId);
  session.publish([
    {
      type: 'run.end',
      aggregateId: qualifyAggregateId('run', runId),
      outcome,
      output: emptyRunEndOutput(AgentCategory.ToolUse),
    },
  ]);
  await session.settlePublications();
}

/**
 * An isolated session for node tests, with the given host interactions
 * attached: run-scoped code that resolves `currentSession().interactions`
 * (presentation) or `currentSession().approvals` (bypass state, queues)
 * reaches this session's owners. A session's facts are read back with
 * {@link recordSessionEvents}. Passing another session's
 * `SessionHostInteractions` makes it this session's owner too, so a
 * recording host can be shared across the sessions of one test.
 */
export function sessionWithInteractions(
  interactions:
    | HostInteractions
    | SessionHostInteractions
    | Pick<SessionHostInteractions, 'emit'>
    | undefined,
): SessionHandle {
  const session = createTestSession();
  if (interactions instanceof SessionHostInteractions) {
    Object.assign(session, {
      interactions,
      approvals: createSessionApprovals(interactions),
    });
    return session;
  }
  if (interactions) session.interactions.use(interactions);
  return session;
}

/** The bash permission payload a `request.opened` carries. */
export function bashApprovalRequest(request: {
  readonly command: string;
  readonly cwd?: string;
  readonly runId?: RunId;
}): BashPermission {
  return {
    requestId: `bash-${generateShortId()}`,
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    allowBypass: true,
    runId: request.runId ?? '',
  };
}

/** A tool-edit request carrying the prompt the tool boundary prepares. */
export function toolEditApprovalRequest(
  request: Omit<ToolEditApprovalRequest, 'permission'>,
  session: SessionHandle = sessionWithInteractions(undefined),
): ToolEditApprovalRequest {
  return {
    ...request,
    permission: prepareToolEditApprovalPrompt(session, {
      requestId: `approval-${generateShortId()}`,
      request,
      relativePath: WorkspaceFS.relativePath(request.path),
    }),
  };
}
