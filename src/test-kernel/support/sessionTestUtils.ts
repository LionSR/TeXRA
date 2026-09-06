import '@test/support/sessionGraphTestSetup';

import { openSession } from '@agent/runtime/sessionGraph';
import {
  forEachLiveSession,
  type SessionHandle,
  type SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import { processWorkspaceRoots } from '@platform/workspaceRoots';
import {
  aggregateId,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { StreamLogStore } from '@transcript';
import { generateExecutionId } from '@utils/core';

type TestSessionInit = Omit<SessionHandleInit, 'transcripts'> & {
  readonly transcripts?: StreamLogStore;
};

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
    transcripts:
      init.transcripts ?? StreamLogStore.ephemeral('isolated test session'),
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
    transcripts:
      init.transcripts ?? StreamLogStore.ephemeral('process test session'),
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
