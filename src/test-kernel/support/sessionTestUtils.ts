import '@test/support/sessionGraphTestSetup';

import { Effect } from 'effect';
import { TraceEmitter, type AgentTrace } from '@agent/trace';
import { heldSessions, openSessionEffect } from '@agent/runtime/sessionGraph';
import type {
  SessionHandle,
  SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import { aggregateId, type RunId, type RunPhase } from '@shared/schemas';
import { isTranscriptEvent } from '@shared/schemas';
import type { SessionOpenError } from '@shared/session/database';
import { createTranscriptFold } from '@shared/session/traceFold';
import { StreamLog } from '@shared/session/traceEntries';
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
    yield* Effect.forEach(predecessors, (live) => live.dispose(), {
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

/** Exercise the pure transcript projection with deterministic source coordinates. */
export function attachTestTranscriptFold(
  trace: AgentTrace,
  runId: RunId,
  log: StreamLog,
) {
  const fold = createTranscriptFold(log);
  let seq = 0;
  const unsubscribe = trace.subscribe((event) => {
    if (!isTranscriptEvent(event)) return;
    seq += 1;
    fold.record(event, {
      at: seq,
      id: JSON.stringify([runId, seq]),
      debug: false,
    });
  });
  return {
    unsubscribe,
    /** The phase the run's fold reached; the transcript projection settles
     *  its open rows on it. */
    settlePhase: (phase: RunPhase) => fold.status(phase),
  };
}

/** Standalone trace projection for tests that exercise formatting without a session. */
export function createTestRunTrace(
  runId: RunId,
  log: StreamLog = new StreamLog(),
) {
  const trace = new TraceEmitter();
  const projection = attachTestTranscriptFold(trace, runId, log);
  return {
    trace,
    settlePhase: projection.settlePhase,
    dispose: projection.unsubscribe,
  };
}
