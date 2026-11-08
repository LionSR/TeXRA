import {
  Effect,
  Context,
  Fiber,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { TraceEmitter } from '@agent/trace/TraceEmitter';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { registryOf, Runs } from '@agent/runtime/runRegistry';
import {
  runStateAppend,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import {
  isTranscriptEvent,
  type AggregateId,
  type RunId,
  type SessionRow,
  type SessionRowDraft,
} from '@shared/schemas';
import { buildRunTranscript } from '@shared/session/transcriptUpdate';
import { type ApprovalPolicy } from '@shared/approvalPolicy';
import { generateRunId } from '@shared/schemas';
import { FakeHost } from '@test/support/testKernel';
import { runStart } from '@test/support/sessionRows';
import { APPROVAL_POLICY_SETTING } from '@texra-ai/harness/schemas';

/**
 * Commit rows on the session's log, in the caller's fiber: a batch the
 * store rejects fails the test where it was published.
 */
export const publishTestRows = (
  session: Context.Context<SessionServices>,
  rows: readonly SessionRowDraft[],
): Effect.Effect<void> =>
  seedRows(Context.get(session, SessionLog))(rows).pipe(
    Effect.asVoid,
    Effect.orDie,
  );

/** A fixture's rows committed as the store holds them, every kind
 *  admitted: a seeded history stands in for what a run's cell wrote. */
export const seedRows =
  (log: Pick<SessionLog['Service'], 'transact'>) =>
  (rows: readonly SessionRowDraft[]) =>
    log.transact((tx) => runStateAppend(tx.append)(rows));

/**
 * Publish the existence fact before a test exercises a run's later events.
 * A child names its parent, whose own `run.start` must already be published.
 */
export function publishTestRunStart(
  session: Context.Context<SessionServices>,
  runId: RunId = generateRunId(),
  options: { parent?: RunId | null } = {},
): Effect.Effect<RunId> {
  return publishTestRows(session, [
    runStart(runId, {
      // A chat run takes a message, as the runs these suites message do.
      takesFollowUps: true,
      parent:
        options.parent == null ? null : { id: options.parent, call: null },
    }),
  ]).pipe(Effect.as(runId));
}

/**
 * Hold `runId` as a launch of this session for the caller's scope, as a run
 * started here is held: the registry records it (the view's `runsHere`),
 * with no loop behind it, and lets it go when the scope closes. Its
 * `run.start` must be published; returns once the view shows it held.
 */
export const holdTestRun = (
  session: Context.Context<SessionServices>,
  runId: RunId,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      registryOf(Context.get(session, Runs))
        .start(runId, { open: Effect.void, run: () => Effect.never })
        .pipe(Effect.orDie),
      ({ fiber }) => Fiber.interrupt(fiber),
    );
    yield* SubscriptionRef.changes(
      Context.get(session, SessionViewAccess).ref,
    ).pipe(
      Stream.takeUntil((view) => view.runs.get(runId)?.holder === 'here'),
      Stream.runDrain,
    );
  });

/**
 * The follow-ups a run's rows still queue, as every view lists them: the
 * session's publications settled, then one cold read of the fold.
 */
export const queuedFollowUps = (
  session: Context.Context<SessionServices>,
  runId: RunId,
) =>
  Effect.gen(function* () {
    yield* Context.get(session, SessionLog).settled;
    const view = yield* Context.get(session, SessionViewAccess).read([runId]);
    return view.queuedFollowUps.get(runId) ?? [];
  });

/**
 * A standalone run trace whose transcript events are recorded as one plain
 * agent run's rows, read the way a stored run is (`buildRunTranscript`), for
 * tests that exercise the transcript reducer without a session.
 */
export function createTestRunTrace(runId: RunId) {
  // Fixture run ids need not be well-formed; the reducer only stamps them.
  // cast: the key's shape is canonical, only its run id may be a fixture's.
  const aggregateId = JSON.stringify(['run', runId]) as AggregateId;
  const rows: object[] = [
    { type: 'run.start', identity: { kind: 'agent', agent: 'test' } },
  ];
  const record = (fact: object) => rows.push(fact);
  const trace = new TraceEmitter((event) => {
    if (isTranscriptEvent(event)) record(event);
  });
  return {
    trace,
    /** The run history's final-answer row (`response.finalized`), recorded
     *  in its place beside the trace. */
    finalize: (text: string) => record({ type: 'response.finalized', text }),
    rows: () =>
      buildRunTranscript(
        rows.map((fact, index) => ({
          ...fact,
          aggregateId,
          seq: index + 1,
          at: index + 1,
          // cast: the trace's transcript events are session event payloads.
        })) as SessionRow[],
        false,
      ).rows,
    dispose: () => trace.close(),
  };
}

/** Set the approval policy, in the `local` scope its row is written to: the
 *  setting every session over the fake host's roots decides by. */
export const setTestApprovalPolicy = (
  policy: ApprovalPolicy,
): Effect.Effect<void, never, FakeHost> =>
  Effect.flatMap(FakeHost, ({ roots }) =>
    roots.config.update(APPROVAL_POLICY_SETTING.key, policy, 'local'),
  ).pipe(Effect.orDie);
