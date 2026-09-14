/**
 * The TUI's approval Surface over the fold: which request the modal shows,
 * in what order, and how the status bar's attention list reads.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  approvalPayloadRunId,
  attentionRequests,
  currentApproval,
  promoteApprovalsForRun,
  type ApprovalPayload,
} from '@cli/chat/tui/state/approvalQueue';
import { resetCliState } from '@cli/chat/tui/state/cliState';
import type { RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';

import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

const RUN_A = 'run-a' as RunId;
const RUN_B = 'run-b' as RunId;
const WORKFLOW = 'workflow' as RunId;
const WORKFLOW_CHILD = 'workflow-child' as RunId;

function bashPayload(runId: RunId | '', requestId = `bash-${runId}`) {
  return {
    kind: 'bash',
    data: { requestId, allowBypass: true, runId, command: 'echo ok' },
  } satisfies ApprovalPayload;
}

function questionPayload(runId: RunId) {
  return {
    kind: 'userQuestion',
    data: {
      requestId: `question-${runId}`,
      allowBypass: false,
      runId,
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
    },
  } satisfies ApprovalPayload;
}

/** The view after each payload's `request.opened` folded, in order. */
function viewOfRequests(...payloads: readonly ApprovalPayload[]): SessionView {
  const runs = [...new Set(payloads.map((p) => p.data.runId))]
    .filter((id): id is RunId => id !== '')
    .map((id) => makeRunView({ id }));
  return viewWith(runs, {
    requests: payloads.map((payload) => ({
      runId: payload.data.runId as RunId,
      requestId: payload.data.requestId,
      payload,
      thread: null,
    })),
  });
}

beforeAll(bindTestSessionView);
afterEach(() => resetCliState());

describe('CLI approval surface', () => {
  it("shows the fold's first outstanding approval and reads the rest as attention", () => {
    const first = bashPayload(RUN_A);
    const second = questionPayload(RUN_B);
    const view = viewOfRequests(first, second);
    seedView(view);

    expect(currentApproval.get()?.payload).toEqual(first);
    expect(attentionRequests(view).map((r) => r.kind)).toEqual([
      'bash',
      'userQuestion',
    ]);
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

  it('promotes a run to the head without settling or re-presenting', () => {
    const a = bashPayload(RUN_A);
    const b1 = bashPayload(RUN_B, 'bash-b-1');
    const b2 = bashPayload(RUN_B, 'bash-b-2');
    const view = viewOfRequests(a, b1, b2);
    seedView(view);
    expect(currentApproval.get()?.payload).toEqual(a);

    promoteApprovalsForRun(RUN_B);
    expect(currentApproval.get()?.payload).toEqual(b1);
    expect(attentionRequests(view).map((r) => r.requestId)).toEqual([
      'bash-b-1',
      'bash-b-2',
      'bash-run-a',
    ]);
  });

  it("promotes the requests of a workflow popup's children with it", () => {
    const a = bashPayload(RUN_A);
    const child = bashPayload(WORKFLOW_CHILD);
    const view = viewOfRequests(a, child);
    seedView(view);

    promoteApprovalsForRun(WORKFLOW, {
      includeRunIds: new Set([WORKFLOW_CHILD]),
    });
    expect(currentApproval.get()?.payload).toEqual(child);
  });

  it('holds a tool edit or retry back until its hook presents the payload', () => {
    const edit = {
      kind: 'toolEdit',
      data: {
        requestId: 'edit-1',
        allowBypass: true,
        runId: RUN_A,
        path: 'paper.tex',
        summary: 'Edit paper.tex',
        diff: '',
        sourceTool: 'edit',
      },
    } as unknown as ApprovalPayload;
    const bash = bashPayload(RUN_A);
    seedView(viewOfRequests(edit, bash));

    expect(currentApproval.get()?.payload).toEqual(bash);
  });

  it('extracts run ids from every approval payload used by the TUI', () => {
    expect(approvalPayloadRunId(bashPayload(RUN_A))).toBe('run-a');
    expect(approvalPayloadRunId(questionPayload(RUN_B))).toBe('run-b');
    expect(approvalPayloadRunId(bashPayload(''))).toBeUndefined();
  });
});
