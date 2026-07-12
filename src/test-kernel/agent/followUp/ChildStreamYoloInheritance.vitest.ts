// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import type { StreamTabId } from '@shared/schemas';
import {
  cleanupAllApprovals,
  enableYoloOnChildStream,
  inheritBashBypassOnChildStream,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  setBashApprovalSessionBypass,
} from '@tools/approval';

import { createRecordingHost } from '../progressTestUtils';

describe('child subagent stream approval inheritance', () => {
  afterEach(() => {
    cleanupAllApprovals();
  });

  it('mirrors the parent bash bypass onto the child stream', () => {
    const { host } = createRecordingHost();
    const parent = 'stream:parent-bash' as StreamTabId;
    const child = 'stream:child-bash' as StreamTabId;
    setBashApprovalSessionBypass(parent, true, host, { silent: true });
    // Sanity: the parent bypass round-trips through the public barrel.
    expect(isBashApprovalBypassedForStream(parent)).toBe(true);

    inheritBashBypassOnChildStream(child, parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
  });

  it('leaves the child gated when the parent still prompts for bash', () => {
    const parent = 'stream:parent-no-bash' as StreamTabId;
    const child = 'stream:child-no-bash' as StreamTabId;

    inheritBashBypassOnChildStream(child, parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(false);
  });

  it('mirrors bash independently of tool-edit YOLO (CLI AUTO-BASH, no AUTO-APPROVE)', () => {
    // The bug this guards against: a parent with bash auto-approved but edits
    // still gated must still propagate bash to the child, even though the child
    // does not get tool-edit YOLO.
    const { host } = createRecordingHost();
    const parent = 'stream:parent-bash-only' as StreamTabId;
    const child = 'stream:child-bash-only' as StreamTabId;
    setBashApprovalSessionBypass(parent, true, host, { silent: true });

    inheritBashBypassOnChildStream(child, parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
    // No edit-YOLO was applied, so tool-edit stays gated on the child.
    expect(isApprovalBypassedForStream(child)).toBe(false);
  });

  it('enables tool-edit YOLO on the child without touching bash', () => {
    const child = 'stream:child-edit' as StreamTabId;

    enableYoloOnChildStream(child);

    expect(isApprovalBypassedForStream(child)).toBe(true);
    expect(isBashApprovalBypassedForStream(child)).toBe(false);
  });
});
