/**
 * Regression test for a dedup bug fixed alongside the `permissionId()`
 * helper: the old `UPDATE_PERMISSION` "show" handler read the wrong id field
 * for `PLAN_APPROVAL` (which then spelled its id `approvalId`), so a replayed
 * plan-approval prompt never matched an existing entry and duplicates were
 * never deduplicated on `replay()`. The id spellings have since been unified
 * onto `requestId`; the replay-dedup behavior is what this pins.
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

function showPlanApproval(requestId: string) {
  return {
    command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
    action: 'show' as const,
    permission: {
      kind: PERMISSION_KIND.PLAN_APPROVAL,
      data: {
        requestId,
        streamId: 'stream-1' as StreamTabId,
        plan: { objective: 'Do the thing.' },
        goalEnabled: false,
      },
    },
  };
}

describe('permission dedup by permission id', () => {
  beforeEach(() => {
    resetProgressState();
  });

  it('does not duplicate a PLAN_APPROVAL prompt replayed with the same requestId', () => {
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

  it('still shows a second PLAN_APPROVAL prompt with a different requestId', () => {
    const onError = vi.fn();

    dispatchMessage(showPlanApproval('approval-1'), onError);
    dispatchMessage(showPlanApproval('approval-2'), onError);

    expect(onError).not.toHaveBeenCalled();
    expect(permissions$.get()).toHaveLength(2);
  });
});
