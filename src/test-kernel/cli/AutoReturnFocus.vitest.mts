import { describe, expect, it } from 'vitest';

import { autoReturnFocusTarget } from '@cli/chat/tui/state/autoReturnFocus';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';

const ROOT = 'root' as StreamTabId;
const CHILD = 'child' as StreamTabId;
const OTHER = 'other-child' as StreamTabId;
const PARENTS = new Map<StreamTabId, StreamTabId>([
  [CHILD, ROOT],
  [OTHER, ROOT],
]);

function decide(
  overrides: Partial<Parameters<typeof autoReturnFocusTarget>[0]>,
) {
  return autoReturnFocusTarget({
    activeStreamId: CHILD,
    parentStream: PARENTS,
    previousStatus: STREAM_PHASE.RUNNING,
    rootStreamId: ROOT,
    status: STREAM_PHASE.COMPLETED,
    streamId: CHILD,
    ...overrides,
  });
}

describe('auto-return focus on child completion', () => {
  it('returns focus to root when the focused child completes', () => {
    expect(decide({})).toBe(ROOT);
    expect(decide({ status: STREAM_PHASE.FAILED })).toBe(ROOT);
    expect(decide({ status: STREAM_PHASE.CANCELLED })).toBe(ROOT);
  });

  it('never fires for waiting-for-you children', () => {
    expect(decide({ status: STREAM_PHASE.WAITING })).toBeUndefined();
    expect(decide({ status: STREAM_PHASE.RUNNING })).toBeUndefined();
  });

  it('only fires for the stream the user is focused on', () => {
    expect(decide({ streamId: OTHER })).toBeUndefined();
    expect(decide({ activeStreamId: ROOT, streamId: ROOT })).toBeUndefined();
    expect(decide({ activeStreamId: undefined })).toBeUndefined();
  });

  it('requires the focused stream to be a child of the tree', () => {
    expect(
      decide({ parentStream: new Map<StreamTabId, StreamTabId>() }),
    ).toBeUndefined();
  });

  it('fires only on a genuine transition edge, never on replays', () => {
    // A re-emitted terminal status (restore/replay) must not yank focus
    // after the user deliberately re-focused the stopped child.
    expect(decide({ previousStatus: STREAM_PHASE.COMPLETED })).toBeUndefined();
    expect(decide({ previousStatus: STREAM_PHASE.FAILED })).toBeUndefined();
    // First-ever status observation still counts as an edge.
    expect(decide({ previousStatus: undefined })).toBe(ROOT);
    expect(decide({ previousStatus: STREAM_PHASE.WAITING })).toBe(ROOT);
  });

  it('needs a root to return to', () => {
    expect(decide({ rootStreamId: undefined })).toBeUndefined();
  });
});
