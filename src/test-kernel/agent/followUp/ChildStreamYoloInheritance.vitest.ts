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
  configureDelegatedChildApprovals,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  proposalApprovals,
  setBashApprovalSessionBypass,
  setDelegatedWorkApprovalBypasses,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';

// Local file imports
import { createRecordingHost } from '../progressTestUtils';

function streamPair(label: string): {
  parent: StreamTabId;
  child: StreamTabId;
} {
  return {
    parent: `stream:${label}-parent` as StreamTabId,
    child: `stream:${label}-child` as StreamTabId,
  };
}

describe('child subagent stream approval inheritance', () => {
  afterEach(() => {
    cleanupAllApprovals();
  });

  it('mirrors the parent bash bypass onto the child stream', () => {
    const { parent, child } = streamPair('bash');
    setBashApprovalSessionBypass(parent, true, { silent: true });
    // Sanity: the parent bypass round-trips through the public barrel.
    expect(isBashApprovalBypassedForStream(parent)).toBe(true);

    configureDelegatedChildApprovals(child, parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
  });

  it('mirrors the parent tool-edit bypass onto the child stream', () => {
    const { parent, child } = streamPair('edit');
    setToolEditApprovalSessionBypass(parent, true, { silent: true });

    configureDelegatedChildApprovals(child, parent);

    expect(isApprovalBypassedForStream(child)).toBe(true);
    // Edit-YOLO inheritance must not drag bash along — kinds stay per-graph.
    expect(isBashApprovalBypassedForStream(child)).toBe(false);
  });

  it('leaves the child gated when the parent still prompts', () => {
    const { parent, child } = streamPair('no-bypass');

    configureDelegatedChildApprovals(child, parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(false);
    expect(isApprovalBypassedForStream(child)).toBe(false);
  });

  it('mirrors bash independently of tool-edit YOLO (CLI AUTO-BASH, no AUTO-APPROVE)', () => {
    // The bug this guards against: a parent with bash auto-approved but edits
    // still gated must propagate bash to the child without also granting the
    // child tool-edit YOLO.
    const { parent, child } = streamPair('bash-only');
    setBashApprovalSessionBypass(parent, true, { silent: true });

    configureDelegatedChildApprovals(child, parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
    // The parent's edits are gated, so the child's stay gated too.
    expect(isApprovalBypassedForStream(child)).toBe(false);
  });

  it('picks up a parent bash bypass toggled after the child stream already started', () => {
    // Regression for the "YOLO forgotten after one round" bug: inheritance
    // used to be a one-shot copy taken at child-creation time, so a bypass
    // enabled on the parent afterwards never reached an already-running
    // child. It must now resolve live off the ancestry link.
    const { parent, child } = streamPair('late-toggle');

    configureDelegatedChildApprovals(child, parent);
    expect(isBashApprovalBypassedForStream(child)).toBe(false);

    setBashApprovalSessionBypass(parent, true, { silent: true });

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
  });

  it('picks up a parent edit-YOLO toggled after the child stream already started', () => {
    // The extension's one shield couples edit + bash bypass; flipping it on
    // while delegated children are already running must reach their edits
    // exactly like it reaches their bash. Tool-edit inheritance used to be a
    // one-shot grant at delegation launch, so a mid-run toggle left children
    // prompting for every edit.
    const { parent, child } = streamPair('late-edit');

    configureDelegatedChildApprovals(child, parent);
    expect(isApprovalBypassedForStream(child)).toBe(false);

    setToolEditApprovalSessionBypass(parent, true, { silent: true });
    expect(isApprovalBypassedForStream(child)).toBe(true);

    // And back off: the child follows the parent's current state, not a
    // snapshot taken at delegation time.
    setToolEditApprovalSessionBypass(parent, false, { silent: true });
    expect(isApprovalBypassedForStream(child)).toBe(false);
  });

  it('announces inherited edit-bypass changes for visible descendants', () => {
    const { events, interactions } = createRecordingHost();
    const detach = currentSession().useHostInteractions(interactions);
    const { parent, child } = streamPair('visible');
    const grandchild = 'stream:visible-grandchild' as StreamTabId;
    const pinnedChild = 'stream:pinned-child' as StreamTabId;
    setToolEditApprovalSessionBypass(parent, true, { silent: true });
    configureDelegatedChildApprovals(child, parent);
    configureDelegatedChildApprovals(grandchild, child);
    configureDelegatedChildApprovals(pinnedChild, parent);
    setToolEditApprovalSessionBypass(pinnedChild, true, { silent: true });

    try {
      setToolEditApprovalSessionBypass(parent, false);

      expect(
        events.filter(({ event }) => event === 'setApprovalBypassState'),
      ).toEqual([
        {
          event: 'setApprovalBypassState',
          payload: {
            streamId: parent,
            kind: 'toolEdit',
            bypassActive: false,
          },
        },
        {
          event: 'setApprovalBypassState',
          payload: {
            streamId: child,
            kind: 'toolEdit',
            bypassActive: false,
          },
        },
        {
          event: 'setApprovalBypassState',
          payload: {
            streamId: grandchild,
            kind: 'toolEdit',
            bypassActive: false,
          },
        },
      ]);
      expect(isApprovalBypassedForStream(pinnedChild)).toBe(true);
    } finally {
      detach();
    }
  });

  it('lets a conversation round inherit bypass from the previous round via the session-level ancestry link', () => {
    // Mirrors the CLI: every chat round mints a brand-new root StreamTabId,
    // so bypass must be carried forward explicitly (see
    // chatSessionController.ts's onStreamResolved) rather than assumed to
    // survive on the same stream id.
    const roundOne = 'stream:round-1' as StreamTabId;
    const roundTwo = 'stream:round-2' as StreamTabId;

    setDelegatedWorkApprovalBypasses(roundOne, true);
    currentSession().approvals.registerStreamParent(roundTwo, roundOne);

    expect(proposalApprovals().isBypassed(roundTwo)).toBe(true);
    expect(isApprovalBypassedForStream(roundTwo)).toBe(true);
    expect(isBashApprovalBypassedForStream(roundTwo)).toBe(true);

    // An explicit toggle on the later round still wins over the inherited one.
    setBashApprovalSessionBypass(roundTwo, false, { silent: true });
    expect(isBashApprovalBypassedForStream(roundTwo)).toBe(false);
    expect(isBashApprovalBypassedForStream(roundOne)).toBe(true);
    expect(proposalApprovals().isBypassed(roundTwo)).toBe(true);
    expect(isApprovalBypassedForStream(roundTwo)).toBe(true);
  });

  it('an explicit child value overrides inherited bypass without touching the parent', () => {
    const { parent, child } = streamPair('toggle');
    setBashApprovalSessionBypass(parent, true, { silent: true });
    configureDelegatedChildApprovals(child, parent);
    expect(isBashApprovalBypassedForStream(child)).toBe(true);

    setBashApprovalSessionBypass(child, false);
    expect(isBashApprovalBypassedForStream(child)).toBe(false);
    // The parent's own bypass is untouched by the child's explicit value.
    expect(isBashApprovalBypassedForStream(parent)).toBe(true);
  });

  it('preserves a surviving child state when its parent is torn down', () => {
    const { parent, child } = streamPair('torn-down');
    setBashApprovalSessionBypass(parent, true, { silent: true });
    configureDelegatedChildApprovals(child, parent);
    expect(isBashApprovalBypassedForStream(child)).toBe(true);

    cleanupApprovalsForStream(parent);

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
    setBashApprovalSessionBypass(parent, false, { silent: true });
    expect(isBashApprovalBypassedForStream(child)).toBe(true);
  });

  it('pins edit approval for an auto-approved delegation', () => {
    const { parent, child } = streamPair('auto-approved');

    configureDelegatedChildApprovals(child, parent, 'auto-approved');

    expect(isApprovalBypassedForStream(parent)).toBe(false);
    expect(isApprovalBypassedForStream(child)).toBe(true);
  });

  it('preserves independent ancestry when one kind loses its parent', () => {
    const editParent = 'stream:edit-parent-cleanup' as StreamTabId;
    const bashParent = 'stream:bash-parent-survives' as StreamTabId;
    const child = 'stream:split-ancestry-child' as StreamTabId;
    setToolEditApprovalSessionBypass(editParent, true, { silent: true });
    setBashApprovalSessionBypass(bashParent, true, { silent: true });
    currentSession().approvals.registerStreamParent(child, editParent, [
      'toolEdit',
    ]);
    currentSession().approvals.registerStreamParent(child, bashParent, [
      'bash',
    ]);

    cleanupApprovalsForStream(editParent);
    setBashApprovalSessionBypass(bashParent, false, { silent: true });

    expect(isApprovalBypassedForStream(child)).toBe(true);
    expect(isBashApprovalBypassedForStream(child)).toBe(false);
  });

  it('super-YOLO on an inheriting child pins its own edit bypass', () => {
    // `setDelegatedWorkApprovalBypasses` must write the child's own explicit
    // tool-edit entry even when `isBypassed` already reports true via
    // ancestry — otherwise the grant silently evaporates when the parent
    // later re-gates its own edits while the child's proposal/bash stay on.
    const { parent, child } = streamPair('pin');
    setToolEditApprovalSessionBypass(parent, true, { silent: true });
    configureDelegatedChildApprovals(child, parent);
    expect(isApprovalBypassedForStream(child)).toBe(true);

    setDelegatedWorkApprovalBypasses(child, true);
    setToolEditApprovalSessionBypass(parent, false, { silent: true });

    expect(isApprovalBypassedForStream(child)).toBe(true);
    expect(isApprovalBypassedForStream(parent)).toBe(false);
  });

  it('propagates delegated-task approval through nested orchestrators', () => {
    const { parent, child } = streamPair('orchestrator');
    const grandchild = 'stream:grandchild-orchestrator' as StreamTabId;
    proposalApprovals().setBypass(parent, true);

    configureDelegatedChildApprovals(child, parent);
    configureDelegatedChildApprovals(grandchild, child);

    expect(proposalApprovals().isBypassed(parent)).toBe(true);
    expect(proposalApprovals().isBypassed(child)).toBe(true);
    expect(proposalApprovals().isBypassed(grandchild)).toBe(true);
  });

  it('keeps ancestry graphs independent per bypass kind', () => {
    // Ancestry used to be one shared graph for all three bypass kinds, so
    // linking a child for bash inheritance silently let it inherit tool-edit
    // YOLO too whenever the parent had it on. Each kind must resolve through
    // its own graph: a bash-only link must not leak tool-edit bypass.
    const { parent, child } = streamPair('split-kinds');
    setToolEditApprovalSessionBypass(parent, true, { silent: true });
    setBashApprovalSessionBypass(parent, true, { silent: true });

    currentSession().approvals.registerStreamParent(child, parent, ['bash']);

    expect(isBashApprovalBypassedForStream(child)).toBe(true);
    // No ancestry link was registered for 'toolEdit', so the child stays
    // gated even though the parent has tool-edit YOLO on.
    expect(isApprovalBypassedForStream(child)).toBe(false);
  });
});
