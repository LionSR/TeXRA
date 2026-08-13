/**
 * Regression test for a dedup bug fixed alongside the `permissionId()`
 * helper: the old `UPDATE_PERMISSION` "show" handler hardcoded `'requestId'`
 * as the id field for every permission kind except `RETRY`, so
 * `PLAN_APPROVAL` — whose id field is `approvalId` — never matched an
 * existing entry and duplicate plan-approval prompts were never
 * deduplicated on `replay()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  permissions$,
  resetProgressState,
} from '@progressView/frontend/progressState';
import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { StreamTabId } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

function showPlanApproval(approvalId: string) {
  return {
    command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
    action: 'show' as const,
    permission: {
      kind: PERMISSION_KIND.PLAN_APPROVAL,
      data: {
        approvalId,
        streamId: 'stream-1' as StreamTabId,
        plan: { objective: 'Do the thing.' },
        goalEnabled: false,
      },
    },
  };
}

describe('permission dedup by kind-specific id field', () => {
  beforeEach(() => {
    resetProgressState();
  });

  it('does not duplicate a PLAN_APPROVAL prompt replayed with the same approvalId', () => {
    const onError = vi.fn();

    dispatchMessage(showPlanApproval('approval-1'), onError);
    expect(onError).not.toHaveBeenCalled();
    expect(permissions$.get()).toHaveLength(1);

    // Replay of the same prompt (e.g. on view visibility change) must not
    // add a second entry.
    dispatchMessage(showPlanApproval('approval-1'), onError);
    expect(onError).not.toHaveBeenCalled();
    expect(permissions$.get()).toHaveLength(1);
  });

  it('still shows a second PLAN_APPROVAL prompt with a different approvalId', () => {
    const onError = vi.fn();

    dispatchMessage(showPlanApproval('approval-1'), onError);
    dispatchMessage(showPlanApproval('approval-2'), onError);

    expect(onError).not.toHaveBeenCalled();
    expect(permissions$.get()).toHaveLength(2);
  });
});
