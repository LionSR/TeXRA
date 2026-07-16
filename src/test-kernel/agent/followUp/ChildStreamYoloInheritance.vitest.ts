// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import { currentSession } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import {
  cleanupAllApprovals,
  cleanupApprovalsForStream,
  enableYoloOnChildStream,
  inheritBashBypassOnChildStream,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  setBashApprovalSessionBypass,
  setToolEditApprovalSessionBypass,
  toggleBashApprovalSessionBypass,
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

  it('picks up a parent bash bypass toggled after the child stream already started', () => {
    // Regression for the "YOLO forgotten after one round" bug: inheritance
    // used to be a one-shot copy taken at child-creation time, so a bypass
    // enabled on the parent afterwards never reached an already-running
    // child. It must now resolve live off the ancestry link.
    const { host } = createRecordingHost();
    const parent = 'stream:parent-late-toggle' as StreamTabId;
    const child = 'stream:child-late-toggle' as StreamTabId;

    inheritBashBypassOnChildStream(child, parent);
    expect(isBashApprovalBypassedForStream(child)).toBe(false);

    setBashApprovalSessionBypass(parent, true, host, { silent: true });

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
  });

  it('lets a conversation round inherit bypass from the previous round via the session-level ancestry link', () => {
    // Mirrors the CLI: every chat round mints a brand-new root StreamTabId,
    // so bypass must be carried forward explicitly (see
    // chatSessionController.ts's onStreamResolved) rather than assumed to
    // survive on the same stream id.
    const { host } = createRecordingHost();
    const roundOne = 'stream:round-1' as StreamTabId;
    const roundTwo = 'stream:round-2' as StreamTabId;

    setBashApprovalSessionBypass(roundOne, true, host, { silent: true });
    currentSession().approvals.registerStreamParent(roundTwo, roundOne);

    expect(isBashApprovalBypassedForStream(roundTwo)).toBe(true);

    // An explicit toggle on the later round still wins over the inherited one.
    setBashApprovalSessionBypass(roundTwo, false, host, { silent: true });
    expect(isBashApprovalBypassedForStream(roundTwo)).toBe(false);
    expect(isBashApprovalBypassedForStream(roundOne)).toBe(true);
  });

  it('toggling a stream that only inherits bypass turns it off on the first press', () => {
    // Toggle used to flip the stream's own (unset) explicit entry —
    // `!undefined` — landing on an explicit `true` that looked like a no-op
    // to the user. It must flip the *resolved* state instead.
    const { host } = createRecordingHost();
    const parent = 'stream:parent-toggle' as StreamTabId;
    const child = 'stream:child-toggle' as StreamTabId;
    setBashApprovalSessionBypass(parent, true, host, { silent: true });
    inheritBashBypassOnChildStream(child, parent);
    expect(isBashApprovalBypassedForStream(child)).toBe(true);

    const first = toggleBashApprovalSessionBypass(child, host);
    expect(first).toBe(false);
    expect(isBashApprovalBypassedForStream(child)).toBe(false);
    // The parent's own bypass is untouched by the child's toggle.
    expect(isBashApprovalBypassedForStream(parent)).toBe(true);
  });

  it('detaches a child from a torn-down parent instead of leaving it inheriting through a dead stream', () => {
    // Per-stream cleanup used to clear only the parent's own bypass
    // entries, leaving the ancestry link intact so a live child silently
    // changed effective bypass the moment the parent's tab closed.
    const { host } = createRecordingHost();
    const parent = 'stream:parent-torn-down' as StreamTabId;
    const child = 'stream:child-survives-parent' as StreamTabId;
    setBashApprovalSessionBypass(parent, true, host, { silent: true });
    inheritBashBypassOnChildStream(child, parent);
    expect(isBashApprovalBypassedForStream(child)).toBe(true);

    cleanupApprovalsForStream(parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(false);
  });

  it('does not let bash ancestry also grant tool-edit or proposal bypass', () => {
    // Ancestry used to be one shared graph for all three bypass kinds, so
    // linking a child for bash inheritance silently let it inherit tool-edit
    // YOLO too whenever the parent had it on — even without
    // `enableYoloOnChild`. Each kind must have its own independent ancestry
    // graph.
    const { host } = createRecordingHost();
    const parent = 'stream:parent-toolEdit-on' as StreamTabId;
    const child = 'stream:child-bash-only-ancestry' as StreamTabId;
    setToolEditApprovalSessionBypass(parent, true, host, { silent: true });
    setBashApprovalSessionBypass(parent, true, host, { silent: true });

    inheritBashBypassOnChildStream(child, parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
    // No ancestry link was registered for 'toolEdit', so the child stays
    // gated even though the parent has tool-edit YOLO on.
    expect(isApprovalBypassedForStream(child)).toBe(false);
  });
});
