import '@test/support/sessionGraphTestSetup';

import type { AgentTrace, StatusEvent } from '@agent/trace';
import { openSession } from '@agent/runtime/sessionGraph';
import {
  forEachLiveSession,
  type SessionHandle,
  type SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import { isDebugModeEnabled } from '@logger/logUtils';
import { processWorkspaceRoots } from '@platform/workspaceRoots';
import { aggregateId, type RunId } from '@shared/schemas';
import { isTranscriptEvent } from '@shared/schemas';
import { createTranscriptFold } from '@shared/session/traceFold';
import { StreamLog } from '@shared/session/traceEntries';
import { createRunTrace } from '@transcript';
import { generateRunId } from '@utils/core';

type TestSessionInit = SessionHandleInit;

let opened = 0;

/**
 * Open an isolated session with an explicitly ephemeral transcript, on a
 * storage root of its own under the process roots (one root holds one
 * session): it shares a graph with no other test session and not with the
 * process default session.
 */
export function createTestSession(init: TestSessionInit = {}): SessionHandle {
  const process = processWorkspaceRoots();
  opened += 1;
  return openSession({
    ...init,
    roots: init.roots ?? {
      workspace: process.workspace,
      storage: `${process.storage}/test-sessions/${opened}`,
      config: process.config,
      workspaceState: process.workspaceState,
    },
    transcriptMode: init.transcriptMode ?? {
      kind: 'ephemeral',
      reason: 'isolated test session',
    },
  });
}

/**
 * Open a fresh session over the process roots, for a file that seeds or
 * reads the process storage outside the session's scope. One root holds one
 * session, so a session still open there (a previous test's) is released
 * first: the caller gets its own, over the store it supplies.
 */
export function createProcessSession(
  init: TestSessionInit = {},
): SessionHandle {
  const roots = processWorkspaceRoots();
  forEachLiveSession((live) => {
    if (live.roots.storage === roots.storage) live.dispose();
  });
  return openSession({
    ...init,
    roots,
    transcriptMode: init.transcriptMode ?? {
      kind: 'ephemeral',
      reason: 'process test session',
    },
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
      debug: isDebugModeEnabled(),
    });
  });
  return {
    unsubscribe,
    handleStatus: (event: StatusEvent) => {
      if (event.runId === runId) fold.status(event.phase);
    },
  };
}

/** Standalone trace projection for tests that exercise formatting without a session. */
export function createTestRunTrace(
  runId: RunId,
  log: StreamLog = new StreamLog(),
) {
  const run = createRunTrace();
  const projection = attachTestTranscriptFold(run.trace, runId, log);
  return {
    trace: run.trace,
    handleStatus: projection.handleStatus,
    dispose: () => {
      projection.unsubscribe();
      run.dispose();
    },
  };
}
