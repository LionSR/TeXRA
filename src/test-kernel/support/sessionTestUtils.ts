import '@test/support/sessionGraphTestSetup';

import { Effect } from 'effect';
import { TraceEmitter, type AgentTrace } from '@agent/trace';
import { heldSessions, openSessionEffect } from '@agent/runtime/sessionGraph';
import type {
  SessionHandle,
  SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  isTranscriptEvent,
  type AggregateId,
  RUN_PHASE,
  type RunId,
  type RunPhase,
  type SessionEvent,
} from '@shared/schemas';
import type { SessionOpenError } from '@shared/session/database';
import type { TranscriptView } from '@shared/session/sessionView';
import { foldTranscriptEvent } from '@shared/session/transcriptFold';
import {
  emptyTranscript,
  resetTranscriptOwnership,
} from '@shared/session/transcriptState';
import { closeSessionOf } from '@test/support/sessionEnd';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { generateRunId } from '@utils/core';

/** What a test supplies: the isolated roots are this helper's job. */
type TestSessionInit = Partial<SessionHandleInit>;

let opened = 0;

/**
 * Open an isolated session with an explicitly ephemeral transcript, on a
 * storage root of its own under the process roots (one root holds one
 * session): it shares a graph with no other test session and not with the
 * process default session.
 */
export function createTestSession(init: TestSessionInit = {}): SessionHandle {
  const installed = testWorkspaceRoots();
  opened += 1;
  // An ephemeral session's graph builds synchronously.
  return Effect.runSync(
    openSessionEffect({
      ...init,
      roots: init.roots ?? {
        workspace: installed.workspace,
        storage: `${installed.storage}/test-sessions/${opened}`,
        globalStorage: installed.globalStorage,
        config: installed.config,
        workspaceState: installed.workspaceState,
        globalState: installed.globalState,
      },
      transcriptMode: init.transcriptMode ?? {
        kind: 'ephemeral',
        reason: 'isolated test session',
      },
    }),
  );
}

/**
 * Open a fresh session over the process roots, for a file that seeds or
 * reads the process storage outside the session's scope. One root holds one
 * session, so a session still open there (a previous test's) is released
 * first, and its release is awaited: `dispose` settles once the root's entry
 * has unwound, and an open issued before that would race it. The caller
 * gets its own session, over the store it supplies.
 */
export function createProcessSession(
  init: TestSessionInit = {},
): Effect.Effect<SessionHandle, SessionOpenError> {
  return Effect.gen(function* () {
    const roots = testWorkspaceRoots();
    const predecessors = heldSessions().filter(
      (live) => live.roots.storage === roots.storage,
    );
    yield* Effect.forEach(predecessors, (live) => closeSessionOf(live), {
      discard: true,
    });
    return yield* openSessionEffect({
      ...init,
      roots,
      transcriptMode: init.transcriptMode ?? {
        kind: 'ephemeral',
        reason: 'process test session',
      },
    });
  });
}

/**
 * Publish the existence fact before a test exercises a run's later events.
 * A child names its parent, whose own `run.start` must already be published.
 */
export function publishTestRunStart(
  session: SessionHandle,
  runId: RunId = generateRunId(),
  options: { parent?: RunId | null } = {},
): RunId {
  session.publish([
    {
      type: 'run.start',
      aggregateId: aggregateId('run', runId),
      identity: { kind: 'agent', agent: 'chat' },
      userFollowUpSupport: 'unsupported',
      category: 'toolUse',
      isRemote: false,
      parent: options.parent == null ? null : { id: options.parent },
    },
  ]);
  return runId;
}

/**
 * The follow-ups a run's rows still queue, as every view lists them: the
 * session's publications settled, then one cold read of the fold.
 */
export const queuedFollowUps = (session: SessionHandle, runId: RunId) =>
  Effect.gen(function* () {
    yield* session.settlePublications();
    const view = yield* session.readView([runId]);
    return view.queuedFollowUps.get(runId) ?? [];
  });

/**
 * Fold a trace's events straight into a transcript with deterministic source
 * coordinates, for tests that exercise the fold without a session. Each event
 * is its own publication level, as a session frame of one.
 */
export function attachTestTranscriptFold(
  trace: AgentTrace,
  runId: RunId,
  debug = false,
) {
  // Fixture run ids need not be well-formed; the fold only stamps them.
  const aggregate = JSON.stringify(['run', runId]) as AggregateId;
  const ctx = { debug, lifecycleToTaskGroups: true };
  let transcript: TranscriptView = emptyTranscript();
  let seq = 1;
  const apply = (fact: object) => {
    seq += 1;
    resetTranscriptOwnership();
    transcript = foldTranscriptEvent(
      transcript,
      { ...fact, aggregateId: aggregate, seq, at: seq } as SessionEvent,
      ctx,
    );
  };
  const unsubscribe = trace.subscribe((event) => {
    if (isTranscriptEvent(event)) apply(event);
  });
  return {
    unsubscribe,
    /** The phase the run reached; the fold settles its open rows on it. */
    settlePhase: (phase: RunPhase) => {
      if (phase === RUN_PHASE.RUNNING) apply({ type: 'run.activate' });
      else if (phase === RUN_PHASE.WAITING) {
        apply({ type: 'flow.step', payload: { step: 'waiting' } });
      } else apply({ type: 'run.end', outcome: phase });
    },
    transcript: () => transcript,
    rows: () => transcript.rows,
  };
}

/** Standalone trace projection for tests that exercise formatting without a session. */
export function createTestRunTrace(runId: RunId) {
  const trace = new TraceEmitter();
  const projection = attachTestTranscriptFold(trace, runId);
  return {
    trace,
    settlePhase: projection.settlePhase,
    rows: projection.rows,
    transcript: projection.transcript,
    dispose: projection.unsubscribe,
  };
}
