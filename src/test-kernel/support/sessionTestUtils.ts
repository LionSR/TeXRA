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
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  runStateAppend,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import {
  qualifyAggregateId,
  isTranscriptEvent,
  type AggregateId,
  type RunId,
  type RunOutcome,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import type { TranscriptView } from '@shared/session/sessionView';
import { applyTranscriptEvent } from '@shared/session/transcriptUpdate';
import {
  emptyTranscript,
  emptyTranscriptIndexes,
} from '@shared/session/transcriptState';
import {
  APPROVAL_POLICY_CONFIG_KEY,
  type ApprovalPolicy,
} from '@shared/approvalPolicy';
import { generateRunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

/**
 * Enqueue rows on the session's publisher and return at once, as a detached
 * producer does: they commit in call order, and a reader waits on
 * `session.log.settled` before reading them.
 */
export function publishTestRows(
  session: Context.Context<SessionServices>,
  rows: readonly SessionEventDraft[],
): void {
  Effect.runFork(seedRows(Context.get(session, SessionLog))(rows));
}

/** A fixture's rows committed as the store holds them, every kind
 *  admitted: a seeded history stands in for what a run's cell wrote. */
export const seedRows =
  (log: Pick<SessionLog['Service'], 'transact'>) =>
  (rows: readonly SessionEventDraft[]) =>
    log.transact((tx) => runStateAppend(tx.append)(rows));

/**
 * Publish the existence fact before a test exercises a run's later events.
 * A child names its parent, whose own `run.start` must already be published.
 */
export function publishTestRunStart(
  session: Context.Context<SessionServices>,
  runId: RunId = generateRunId(),
  options: { parent?: RunId | null } = {},
): RunId {
  publishTestRows(session, [
    {
      type: 'run.start',
      aggregateId: qualifyAggregateId('run', runId),
      identity: { kind: 'agent', agent: 'chat' },
      // A chat run takes a message, as the runs these suites message do.
      userFollowUpSupport: 'nativeInteractive',
      parent:
        options.parent == null ? null : { id: options.parent, call: null },
      provenance: null,
    },
  ]);
  return runId;
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
 * A standalone run trace whose events go straight into a transcript with
 * deterministic source coordinates, for tests that exercise the transcript
 * reducer without a session. Each event is its own update call, as a
 * session frame of one.
 */
export function createTestRunTrace(runId: RunId) {
  // Fixture run ids need not be well-formed; the reducer only stamps them.
  // cast: the key's shape is canonical, only its run id may be a fixture's.
  const aggregate = JSON.stringify(['run', runId]) as AggregateId;
  const ctx = { debug: false, lifecycleToTaskGroups: true };
  const ix = emptyTranscriptIndexes();
  let transcript: TranscriptView = emptyTranscript();
  let seq = 1;
  const apply = (fact: object) => {
    seq += 1;
    transcript = applyTranscriptEvent(
      transcript,
      { ix, owned: new WeakSet() },
      // cast: the trace's transcript events are session event payloads.
      { ...fact, aggregateId: aggregate, seq, at: seq } as SessionEvent,
      ctx,
    );
  };
  const trace = new TraceEmitter((event) => {
    if (isTranscriptEvent(event)) apply(event);
  });
  return {
    trace,
    /** The phase the run reached; the reducer closes its open rows on it. */
    settlePhase: (phase: RunOutcome | 'running' | 'waiting') => {
      if (phase === 'running') apply({ type: 'run.activate' });
      else if (phase === 'waiting') {
        apply({ type: 'run.position', payload: { at: 'waiting' } });
      } else apply({ type: 'run.end', outcome: phase });
    },
    /** The run history's final-answer row (`response.finalized`), applied
     *  in its place beside the trace. */
    finalize: (text: string) => apply({ type: 'response.finalized', text }),
    transcript: () => transcript,
    rows: () => transcript.rows,
    dispose: () => trace.close(),
  };
}

/** Set the approval policy, in the `local` scope its row is written to: the
 *  setting every session over `roots` (by default the installed fake
 *  host's) decides by. */
export function setTestApprovalPolicy(
  policy: ApprovalPolicy,
  { config }: Pick<WorkspaceRoots, 'config'> = testWorkspaceRoots(),
): void {
  Effect.runSync(config.update(APPROVAL_POLICY_CONFIG_KEY, policy, 'local'));
}
