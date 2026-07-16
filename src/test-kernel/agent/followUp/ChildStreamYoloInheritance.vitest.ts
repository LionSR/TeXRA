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
  inheritApprovalBypassesOnChildStream,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  proposalApprovals,
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

    inheritApprovalBypassesOnChildStream(child, parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
  });

  it('mirrors the parent tool-edit bypass onto the child stream', () => {
    const { host } = createRecordingHost();
    const parent = 'stream:parent-edit' as StreamTabId;
    const child = 'stream:child-edit' as StreamTabId;
    setToolEditApprovalSessionBypass(parent, true, host, { silent: true });

    inheritApprovalBypassesOnChildStream(child, parent);

    expect(isApprovalBypassedForStream(child)).toBe(true);
    // Edit-YOLO inheritance must not drag bash along — kinds stay per-graph.
    expect(isBashApprovalBypassedForStream(child)).toBe(false);
  });

  it('leaves the child gated when the parent still prompts', () => {
    const parent = 'stream:parent-no-bypass' as StreamTabId;
    const child = 'stream:child-no-bypass' as StreamTabId;

    inheritApprovalBypassesOnChildStream(child, parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(false);
    expect(isApprovalBypassedForStream(child)).toBe(false);
  });

  it('mirrors bash independently of tool-edit YOLO (CLI AUTO-BASH, no AUTO-APPROVE)', () => {
    // The bug this guards against: a parent with bash auto-approved but edits
    // still gated must propagate bash to the child without also granting the
    // child tool-edit YOLO.
    const { host } = createRecordingHost();
    const parent = 'stream:parent-bash-only' as StreamTabId;
    const child = 'stream:child-bash-only' as StreamTabId;
    setBashApprovalSessionBypass(parent, true, host, { silent: true });

    inheritApprovalBypassesOnChildStream(child, parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
    // The parent's edits are gated, so the child's stay gated too.
    expect(isApprovalBypassedForStream(child)).toBe(false);
  });

  it('picks up a parent bash bypass toggled after the child stream already started', () => {
    // Regression for the "YOLO forgotten after one round" bug: inheritance
    // used to be a one-shot copy taken at child-creation time, so a bypass
    // enabled on the parent afterwards never reached an already-running
    // child. It must now resolve live off the ancestry link.
    const { host } = createRecordingHost();
    const parent = 'stream:parent-late-toggle' as StreamTabId;
    const child = 'stream:child-late-toggle' as StreamTabId;

    inheritApprovalBypassesOnChildStream(child, parent);
    expect(isBashApprovalBypassedForStream(child)).toBe(false);

    setBashApprovalSessionBypass(parent, true, host, { silent: true });

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
  });

  it('picks up a parent edit-YOLO toggled after the child stream already started', () => {
    // The extension's one shield couples edit + bash bypass; flipping it on
    // while delegated children are already running must reach their edits
    // exactly like it reaches their bash. Tool-edit inheritance used to be a
    // one-shot grant at delegation launch, so a mid-run toggle left children
    // prompting for every edit.
    const { host } = createRecordingHost();
    const parent = 'stream:parent-late-edit' as StreamTabId;
    const child = 'stream:child-late-edit' as StreamTabId;

    inheritApprovalBypassesOnChildStream(child, parent);
    expect(isApprovalBypassedForStream(child)).toBe(false);

    setToolEditApprovalSessionBypass(parent, true, host, { silent: true });
    expect(isApprovalBypassedForStream(child)).toBe(true);

    // And back off: the child follows the parent's current state, not a
    // snapshot taken at delegation time.
    setToolEditApprovalSessionBypass(parent, false, host, { silent: true });
    expect(isApprovalBypassedForStream(child)).toBe(false);
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
    inheritApprovalBypassesOnChildStream(child, parent);
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
    inheritApprovalBypassesOnChildStream(child, parent);
    expect(isBashApprovalBypassedForStream(child)).toBe(true);

    cleanupApprovalsForStream(parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(false);
  });

  it('does not let delegation ancestry also grant super-YOLO proposal bypass', () => {
    // Delegation links bash + tool-edit only. Proposal (super-YOLO) bypass is
    // deliberately unlinked, so a child's own delegations still prompt unless
    // granted on the child explicitly.
    const { host } = createRecordingHost();
    const parent = 'stream:parent-super-yolo' as StreamTabId;
    const child = 'stream:child-no-proposal' as StreamTabId;
    proposalApprovals().setBypass(parent, true, host);

    inheritApprovalBypassesOnChildStream(child, parent);

    expect(proposalApprovals().isBypassed(parent)).toBe(true);
    expect(proposalApprovals().isBypassed(child)).toBe(false);
  });

  it('keeps ancestry graphs independent per bypass kind', () => {
    // Ancestry used to be one shared graph for all three bypass kinds, so
    // linking a child for bash inheritance silently let it inherit tool-edit
    // YOLO too whenever the parent had it on. Each kind must resolve through
    // its own graph: a bash-only link must not leak tool-edit bypass.
    const { host } = createRecordingHost();
    const parent = 'stream:parent-toolEdit-on' as StreamTabId;
    const child = 'stream:child-bash-only-ancestry' as StreamTabId;
    setToolEditApprovalSessionBypass(parent, true, host, { silent: true });
    setBashApprovalSessionBypass(parent, true, host, { silent: true });

    currentSession().approvals.registerStreamParent(child, parent, ['bash']);

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
    // No ancestry link was registered for 'toolEdit', so the child stays
    // gated even though the parent has tool-edit YOLO on.
    expect(isApprovalBypassedForStream(child)).toBe(false);
  });
});
