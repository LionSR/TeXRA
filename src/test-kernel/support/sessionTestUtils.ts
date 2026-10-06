import '@test/support/sessionGraphTestSetup';

import { Effect } from 'effect';
import { TraceEmitter } from '@agent/trace';
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
import {
  closeSessionOf,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import { testSessionOwner } from '@test/support/testProcessRuntime';
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
export const createTestSession = (
  init: TestSessionInit = {},
): Effect.Effect<SessionHandle, SessionOpenError> =>
  Effect.flatMap(testSessionOwner, (owner) => {
    const installed = testWorkspaceRoots();
    opened += 1;
    return owner.open({
      ...init,
      roots: init.roots ?? {
        host: installed.host,
        workspace: installed.workspace,
        storage: `${installed.storage}/test-sessions/${opened}`,
        globalStorage: installed.globalStorage,
        config: installed.config,
        workspaceState: installed.workspaceState,
        repoState: installed.repoState,
        globalState: installed.globalState,
      },
      transcriptMode: init.transcriptMode ?? {
        kind: 'ephemeral',
        reason: 'isolated test session',
      },
    });
  });

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
    const owner = yield* testSessionOwner;
    const predecessors = (yield* owner.list).filter(
      (live) => live.roots.storage === roots.storage,
    );
    yield* Effect.forEach(predecessors, (live) => closeSessionOf(live), {
      discard: true,
    });
    // The session over the process roots is the file's default session.
    return yield* openTestDefaultSession({
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
      parent:
        options.parent == null ? null : { id: options.parent, callId: null },
      provenance: null,
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
    yield* session.settled;
    const view = yield* session.readView([runId]);
    return view.queuedFollowUps.get(runId) ?? [];
  });

/**
 * A standalone run trace whose events fold straight into a transcript with
 * deterministic source coordinates, for tests that exercise the fold without
 * a session. Each event is its own publication level, as a session frame of
 * one.
 */
export function createTestRunTrace(runId: RunId) {
  // Fixture run ids need not be well-formed; the fold only stamps them.
  const aggregate = JSON.stringify(['run', runId]) as AggregateId;
  const ctx = { debug: false, lifecycleToTaskGroups: true };
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
  const trace = new TraceEmitter((event) => {
    if (isTranscriptEvent(event)) apply(event);
  });
  return {
    trace,
    /** The phase the run reached; the fold settles its open rows on it. */
    settlePhase: (phase: RunPhase) => {
      if (phase === RUN_PHASE.RUNNING) apply({ type: 'run.activate' });
      else if (phase === RUN_PHASE.WAITING) {
        apply({ type: 'run.position', payload: { at: 'waiting' } });
      } else apply({ type: 'run.end', outcome: phase });
    },
    transcript: () => transcript,
    rows: () => transcript.rows,
    dispose: () => trace.close(),
  };
}
