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
import {
  aggregateId,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { isTranscriptEvent } from '@shared/schemas';
import { createTranscriptFold } from '@shared/session/traceFold';
import { createRunTrace, StreamLogStore } from '@transcript';
import type { TranscriptWriter } from '@transcript/StreamLogStore';
import { generateExecutionId } from '@utils/core';

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

/** Publish the existence fact before a test exercises a run's later events. */
export function publishTestRunStart(
  session: SessionHandle,
  streamId: StreamTabId,
  executionId: ExecutionId = generateExecutionId(),
): ExecutionId {
  session.publish([
    {
      type: 'run.start',
      aggregateId: aggregateId('stream', streamId),
      executionId,
      identity: { kind: 'agent', agent: 'chat' },
      userFollowUpSupport: 'unsupported',
      category: 'toolUse',
      isRemote: false,
    },
  ]);
  return executionId;
}

/** Exercise the pure transcript projection with deterministic source coordinates. */
export function attachTestTranscriptFold(
  trace: AgentTrace,
  writer: TranscriptWriter,
) {
  const fold = createTranscriptFold(writer);
  let seq = 0;
  const unsubscribe = trace.subscribe((event) => {
    if (!isTranscriptEvent(event)) return;
    seq += 1;
    fold.record(
      event.type === 'usage'
        ? {
            type: event.type,
            ...event.payload,
            recordTranscript: event.recordTranscript,
            stageId: event.stageId,
          }
        : event,
      {
        at: seq,
        id: JSON.stringify([writer.streamId, seq]),
        debug: isDebugModeEnabled(),
      },
    );
  });
  return {
    unsubscribe,
    handleStatus: (event: StatusEvent) => {
      if (event.streamId === writer.streamId) fold.status(event.phase);
    },
  };
}

/** Standalone trace projection for tests that exercise formatting without a session. */
export function createTestRunTrace(
  streamId: StreamTabId,
  store: StreamLogStore,
) {
  const writer = store.acquireWriter(streamId, streamId);
  const run = createRunTrace(streamId, writer);
  const projection = attachTestTranscriptFold(run.trace, writer);
  return {
    trace: run.trace,
    handleStatus: projection.handleStatus,
    dispose: () => {
      projection.unsubscribe();
      run.dispose();
    },
  };
}
