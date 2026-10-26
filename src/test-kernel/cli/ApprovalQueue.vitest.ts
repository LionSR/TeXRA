/**
 * The TUI's approval Surface over the fold: which request the modal shows,
 * in what order, and how the status bar's attention list reads.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  attentionRequests,
  currentApproval,
  forgetSettledRequests,
  stagePresentation,
  type ApprovalPayload,
} from '@cli/chat/tui/state/approvalQueue';
import {
  resetCliState,
  rootRunId,
  sessionListRunIds,
} from '@cli/chat/tui/state/cliState';
import type { RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';

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

/** The view after each payload's `request.opened` folded, in order. */
function viewOfRequests(...payloads: readonly ApprovalPayload[]): SessionView {
  const runs = [...new Set(payloads.map((p) => p.data.runId))]
    .filter((id): id is RunId => id !== '')
    .map((id) => makeRunView({ id, parentId: ROOT }));
  return viewWith([makeRunView({ id: ROOT }), ...runs], {
    requests: payloads.map((payload) => ({
      runId: payload.data.runId as RunId,
      requestId: payload.data.requestId,
      payload,
    })),
  });
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

  it('presents no request this window cannot answer', () => {
    // A child another process holds: its answer would be refused, and the
    // refusal reopens the modal, trapping the keys.
    const held = bashPayload(RUN_A);
    const view = viewOfRequests(held);
    const run = view.runs.get(RUN_A);
    if (!run) throw new Error('fixture lost its run');
    seedView({
      ...view,
      runs: new Map(view.runs).set(RUN_A, { ...run, readOnly: true }),
    });

    expect(currentApproval.get()).toBeUndefined();
    expect(attentionRequests.get()).toEqual([]);
  });

  it('drops a request the moment the fold resolves it', () => {
    const first = bashPayload(RUN_A);
    const second = bashPayload(RUN_B);
    seedView(viewOfRequests(first, second));
    expect(currentApproval.get()?.payload).toEqual(first);

    seedView(viewOfRequests(second));
    expect(currentApproval.get()?.payload).toEqual(second);

    seedView(viewOfRequests());
    expect(currentApproval.get()).toBeUndefined();
  });

  it('keeps the modal on screen when an older request becomes presentable after a settle', () => {
    const retry = {
      kind: 'retry',
      data: { requestId: 'retry-1', allowBypass: false, runId: RUN_A },
      tui: {},
    } as unknown as ApprovalPayload;
    const a = bashPayload(RUN_A);
    const b = bashPayload(RUN_B);
    seedView(viewOfRequests(retry, a, b));
    expect(currentApproval.get()?.payload).toEqual(a);

    seedView(viewOfRequests(retry, b));
    forgetSettledRequests(new Set(['retry-1', b.data.requestId]));
    expect(currentApproval.get()?.payload).toEqual(b);

    // The retry's key lookup lands: it joins behind the modal being answered.
    stagePresentation(retry);
    expect(currentApproval.get()?.payload).toEqual(b);
  });
});
