/**
 * The TUI's approval Surface over the fold: which request the modal shows,
 * in what order, and how the status bar's attention list reads.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  approvalPayloadStreamId,
  attentionRequests,
  currentApproval,
  promoteApprovalsForStream,
  type ApprovalPayload,
} from '@cli/chat/tui/state/approvalQueue';
import { resetCliState } from '@cli/chat/tui/state/cliState';
import type { StreamTabId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';

import {
  bindTestSessionView,
  makeStreamView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

function bashPayload(streamId: string, requestId = `bash-${streamId}`) {
  return {
    kind: 'bash',
    data: { requestId, allowBypass: true, streamId, command: 'echo ok' },
  } satisfies ApprovalPayload;
}

function questionPayload(streamId: string) {
  return {
    kind: 'userQuestion',
    data: {
      requestId: `question-${streamId}`,
      allowBypass: false,
      streamId,
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
    },
  } satisfies ApprovalPayload;
}

/** The view after each payload's `approval.requested` folded, in order. */
function viewOfApprovals(...payloads: readonly ApprovalPayload[]): SessionView {
  const streams = [...new Set(payloads.map((p) => p.data.streamId))].map((id) =>
    makeStreamView({ id }),
  );
  return viewWith(streams, {
    approvals: payloads.map((payload) => ({
      streamId: payload.data.streamId as StreamTabId,
      requestId: payload.data.requestId,
      payload,
    })),
  });
}

beforeAll(bindTestSessionView);
afterEach(() => resetCliState());

describe('CLI approval surface', () => {
  it("shows the fold's first outstanding approval and reads the rest as attention", () => {
    const first = bashPayload('stream-a');
    const second = questionPayload('stream-b');
    const view = viewOfApprovals(first, second);
    seedView(view);

    expect(currentApproval.get()?.payload).toEqual(first);
    expect(attentionRequests(view).map((r) => r.kind)).toEqual([
      'bash',
      'userQuestion',
    ]);
  });

  it('drops a request the moment the fold resolves it', () => {
    const first = bashPayload('stream-a');
    const second = bashPayload('stream-b');
    seedView(viewOfApprovals(first, second));
    expect(currentApproval.get()?.payload).toEqual(first);

    seedView(viewOfApprovals(second));
    expect(currentApproval.get()?.payload).toEqual(second);

    seedView(viewOfApprovals());
    expect(currentApproval.get()).toBeUndefined();
  });

  it('promotes a stream to the head without settling or re-presenting', () => {
    const a = bashPayload('stream-a');
    const b1 = bashPayload('stream-b', 'bash-b-1');
    const b2 = bashPayload('stream-b', 'bash-b-2');
    const view = viewOfApprovals(a, b1, b2);
    seedView(view);
    expect(currentApproval.get()?.payload).toEqual(a);

    promoteApprovalsForStream('stream-b' as StreamTabId);
    expect(currentApproval.get()?.payload).toEqual(b1);
    expect(attentionRequests(view).map((r) => r.requestId)).toEqual([
      'bash-b-1',
      'bash-b-2',
      'bash-stream-a',
    ]);
  });

  it("promotes the requests of a workflow popup's children with it", () => {
    const a = bashPayload('stream-a');
    const child = bashPayload('workflow-child');
    const view = viewOfApprovals(a, child);
    seedView(view);

    promoteApprovalsForStream('workflow' as StreamTabId, {
      includeStreamIds: new Set(['workflow-child' as StreamTabId]),
    });
    expect(currentApproval.get()?.payload).toEqual(child);
  });

  it('holds a tool edit or retry back until its hook presents the payload', () => {
    const edit = {
      kind: 'toolEdit',
      data: {
        requestId: 'edit-1',
        allowBypass: true,
        streamId: 'stream-a',
        path: 'paper.tex',
        summary: 'Edit paper.tex',
        diff: '',
        sourceTool: 'edit',
      },
    } as unknown as ApprovalPayload;
    const bash = bashPayload('stream-a');
    seedView(viewOfApprovals(edit, bash));

    expect(currentApproval.get()?.payload).toEqual(bash);
  });

  it('extracts stream ids from every approval payload used by the TUI', () => {
    expect(approvalPayloadStreamId(bashPayload('stream-a'))).toBe('stream-a');
    expect(approvalPayloadStreamId(questionPayload('stream-b'))).toBe(
      'stream-b',
    );
    expect(approvalPayloadStreamId(bashPayload(''))).toBeUndefined();
  });
});
