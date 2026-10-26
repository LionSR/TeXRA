/**
 * The TUI's approval Surface over the fold: which request the modal shows,
 * in what order, and how the status bar's attention list reads.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  attentionRequests,
  currentApproval,
  type ApprovalPayload,
} from '@cli/chat/tui/state/approvalQueue';
import {
  resetCliState,
  rootRunId,
  sessionListRunIds,
} from '@cli/chat/tui/state/cliState';
import type { RunId } from '@shared/schemas';

import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

const ROOT = 'chat-root' as RunId;
const RUN_A = 'run-a' as RunId;
const RUN_B = 'run-b' as RunId;

function bashPayload(runId: RunId | '', requestId = `bash-${runId}`) {
  return {
    kind: 'bash',
    data: { requestId, allowBypass: true, runId, command: 'echo ok' },
  } satisfies ApprovalPayload;
}

beforeAll(bindTestSessionView);
beforeEach(() => rootRunId.set(ROOT));
afterEach(() => resetCliState());

describe('CLI approval surface', () => {
  it('isolates approval prompts, counts, and run lists to the current chat', () => {
    const local = bashPayload(RUN_A);
    const foreign = bashPayload(RUN_B);
    const view = viewWith(
      [
        makeRunView({ id: ROOT }),
        makeRunView({ id: RUN_A, parentId: ROOT }),
        makeRunView({ id: RUN_B }),
      ],
      {
        requests: [foreign, local].map((payload) => ({
          runId: payload.data.runId as RunId,
          requestId: payload.data.requestId,
          payload,
        })),
      },
    );
    seedView(view);
    expect(currentApproval.get()?.payload).toEqual(local);
    expect(attentionRequests.get().map((request) => request.runId)).toEqual([
      RUN_A,
    ]);
    expect(sessionListRunIds.get()).toEqual([ROOT]);

    rootRunId.set(RUN_B);
    expect(currentApproval.get()?.payload).toEqual(foreign);
    expect(attentionRequests.get().map((request) => request.runId)).toEqual([
      RUN_B,
    ]);
    expect(sessionListRunIds.get()).toEqual([RUN_B]);

    rootRunId.set(undefined);
    expect(currentApproval.get()).toBeUndefined();
    expect(attentionRequests.get()).toEqual([]);
    expect(sessionListRunIds.get()).toEqual([]);

    // A detached child still owned by this terminal keeps its approval
    // path even after the root conversation has been cleared.
    const detachedView = viewWith(
      [makeRunView({ id: RUN_A, ownedHere: true }), makeRunView({ id: RUN_B })],
      { requests: view.requests },
    );
    seedView(detachedView);
    expect(currentApproval.get()?.payload).toEqual(local);
    expect(attentionRequests.get().map((request) => request.runId)).toEqual([
      RUN_A,
    ]);
    expect(sessionListRunIds.get()).toEqual([RUN_A]);
  });
});
