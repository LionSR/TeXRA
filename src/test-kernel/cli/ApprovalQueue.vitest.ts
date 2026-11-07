/**
 * The TUI's approval Surface over the fold: which request the modal shows,
 * in what order, and how the status bar's attention list reads.
 */
import { layer } from '@effect/vitest';
import { Layer, Schema } from 'effect';
import { afterEach, beforeEach, expect } from 'vitest';

import { RunIdSchema, type RunId } from '@texra-ai/harness/schemas';
import {
  attentionRequests,
  currentApproval,
  type TuiRequest,
} from '@cli/chat/tui/state/approvalQueue';
import {
  resetCliState,
  rootRunId,
  sessionListRunIds,
} from '@cli/chat/tui/state/cliState';
import { SessionGraph } from '@test/support/testKernel';
import {
  boundTestSessionView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

const ROOT = Schema.decodeUnknownSync(RunIdSchema)('c0000a');
const RUN_A = Schema.decodeUnknownSync(RunIdSchema)('a0000a');
const RUN_B = Schema.decodeUnknownSync(RunIdSchema)('b0000b');

function bashPayload(runId: RunId, requestId = `bash-${runId}`) {
  return {
    kind: 'bash',
    data: { requestId, offersGrant: true, runId, command: 'echo ok' },
  } satisfies TuiRequest;
}

// The view is bound on a runtime over the session graph, as the chat entry
// binds it; the surface itself is read synchronously.
layer(Layer.provideMerge(boundTestSessionView, SessionGraph.hosted), {
  excludeTestServices: true,
})('CLI approval surface', (it) => {
  beforeEach(() => rootRunId.set(ROOT));
  afterEach(() => resetCliState());

  it('isolates approval prompts, counts, and run lists to the current chat', () => {
    const local = bashPayload(RUN_A);
    const foreign = bashPayload(RUN_B);
    const view = viewWith(
      [
        { id: ROOT },
        { id: RUN_A, parentId: ROOT },
        // Another chat's run, which nothing in this terminal holds.
        { id: RUN_B, held: false },
      ],
      {
        requests: [foreign, local].map((payload) => ({
          runId: payload.data.runId,
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
    // The child's request holds its parent open.
    expect(sessionListRunIds.get()).toEqual([ROOT, RUN_A]);

    // A detached child still owned by this terminal keeps its approval
    // path even after the root conversation has been cleared.
    rootRunId.set(undefined);
    const detachedView = viewWith([{ id: RUN_A }, { id: RUN_B, held: false }], {
      requests: view.requests,
    });
    seedView(detachedView);
    expect(currentApproval.get()?.payload).toEqual(local);
    expect(attentionRequests.get().map((request) => request.runId)).toEqual([
      RUN_A,
    ]);
    expect(sessionListRunIds.get()).toEqual([RUN_A]);
  });
});
