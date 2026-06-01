// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import type { StreamTabId } from '@shared/schemas';
import {
  cleanupAllApprovals,
  enableYoloOnChildStream,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  setBashApprovalSessionBypass,
} from '@tools/approval';

import { createRecordingHost } from '../progressTestUtils';

describe('enableYoloOnChildStream bash inheritance', () => {
  afterEach(() => {
    cleanupAllApprovals();
  });

  it('mirrors the parent bash bypass onto the child stream', () => {
    const { host } = createRecordingHost();
    const parent = 'stream:parent-yolo' as StreamTabId;
    const child = 'stream:child-yolo' as StreamTabId;
    setBashApprovalSessionBypass(parent, true, host, { silent: true });
    // Sanity: the parent bypass round-trips through the public barrel.
    expect(isBashApprovalBypassedForStream(parent)).toBe(true);

    enableYoloOnChildStream(child, parent);

    // Tool-edit bypass is always enabled for the child; bash follows the parent.
    expect(isApprovalBypassedForStream(child)).toBe(true);
    expect(isBashApprovalBypassedForStream(child)).toBe(true);
  });

  it('keeps child bash gated when the parent still prompts for bash', () => {
    // Mirrors the CLI case where AUTO-APPROVE (tool edits) is on but AUTO-BASH
    // is off: the child inherits exactly the parent's bash state.
    const parent = 'stream:parent-edit-only' as StreamTabId;
    const child = 'stream:child-edit-only' as StreamTabId;

    enableYoloOnChildStream(child, parent);

    expect(isApprovalBypassedForStream(child)).toBe(true);
    expect(isBashApprovalBypassedForStream(child)).toBe(false);
  });
});
