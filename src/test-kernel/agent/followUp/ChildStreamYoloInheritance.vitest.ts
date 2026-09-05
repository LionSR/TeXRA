// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import { currentSession, defaultSession } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import {
  configureDelegatedChildApprovals,
  proposalApprovals,
  releaseStreamResources,
} from '@tools/approval';

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
    defaultSession().approvals.clearAll();
    defaultSession().interactions.cancel({ cause: 'All approvals cleared.' });
  });

  it('mirrors the parent bash bypass onto the child stream', () => {
    const { parent, child } = streamPair('bash');
    currentSession().approvals.bash.bypass.setBypass(parent, true, {
      silent: true,
    });
    // Sanity: the parent bypass round-trips through the public barrel.
    expect(currentSession().approvals.bash.bypass.isBypassed(parent)).toBe(
      true,
    );

    configureDelegatedChildApprovals(child, parent);

    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(true);
  });

  it('mirrors the parent tool-edit bypass onto the child stream', () => {
    const { parent, child } = streamPair('edit');
    currentSession().approvals.toolEdit.bypass.setBypass(parent, true, {
      silent: true,
    });

    configureDelegatedChildApprovals(child, parent);

    expect(currentSession().approvals.toolEdit.bypass.isBypassed(child)).toBe(
      true,
    );
    // Edit-YOLO inheritance must not drag bash along — bypass values stay independent.
    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(
      false,
    );
  });

  it('leaves the child gated when the parent still prompts', () => {
    const { parent, child } = streamPair('no-bypass');

    configureDelegatedChildApprovals(child, parent);

    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(
      false,
    );
    expect(currentSession().approvals.toolEdit.bypass.isBypassed(child)).toBe(
      false,
    );
  });

  it('mirrors bash independently of tool-edit YOLO (CLI AUTO-BASH, no AUTO-APPROVE)', () => {
    // The bug this guards against: a parent with bash auto-approved but edits
    // still gated must propagate bash to the child without also granting the
    // child tool-edit YOLO.
    const { parent, child } = streamPair('bash-only');
    currentSession().approvals.bash.bypass.setBypass(parent, true, {
      silent: true,
    });

    configureDelegatedChildApprovals(child, parent);

    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(true);
    // The parent's edits are gated, so the child's stay gated too.
    expect(currentSession().approvals.toolEdit.bypass.isBypassed(child)).toBe(
      false,
    );
  });

  it('picks up a parent bash bypass toggled after the child stream already started', () => {
    // Regression for the "YOLO forgotten after one round" bug: inheritance
    // used to be a one-shot copy taken at child-creation time, so a bypass
    // enabled on the parent afterwards never reached an already-running
    // child. It must now resolve live off the ancestry link.
    const { parent, child } = streamPair('late-toggle');

    configureDelegatedChildApprovals(child, parent);
    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(
      false,
    );

    currentSession().approvals.bash.bypass.setBypass(parent, true, {
      silent: true,
    });

    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(true);
  });

  it('picks up a parent edit-YOLO toggled after the child stream already started', () => {
    // The extension's one shield couples edit + bash bypass; flipping it on
    // while delegated children are already running must reach their edits
    // exactly like it reaches their bash. Tool-edit inheritance used to be a
    // one-shot grant at delegation launch, so a mid-run toggle left children
    // prompting for every edit.
    const { parent, child } = streamPair('late-edit');

    configureDelegatedChildApprovals(child, parent);
    expect(currentSession().approvals.toolEdit.bypass.isBypassed(child)).toBe(
      false,
    );

    currentSession().approvals.toolEdit.bypass.setBypass(parent, true, {
      silent: true,
    });
    expect(currentSession().approvals.toolEdit.bypass.isBypassed(child)).toBe(
      true,
    );

    // And back off: the child follows the parent's current state, not a
    // snapshot taken at delegation time.
    currentSession().approvals.toolEdit.bypass.setBypass(parent, false, {
      silent: true,
    });
    expect(currentSession().approvals.toolEdit.bypass.isBypassed(child)).toBe(
      false,
    );
  });

  it('announces inherited edit-bypass changes for visible descendants', () => {
    const { events, interactions } = createRecordingHost();
    const detach = currentSession().interactions.use(interactions);
    const { parent, child } = streamPair('visible');
    const grandchild = 'stream:visible-grandchild' as StreamTabId;
    const pinnedChild = 'stream:pinned-child' as StreamTabId;
    currentSession().approvals.toolEdit.bypass.setBypass(parent, true, {
      silent: true,
    });
    configureDelegatedChildApprovals(child, parent);
    configureDelegatedChildApprovals(grandchild, child);
    configureDelegatedChildApprovals(pinnedChild, parent);
    currentSession().approvals.toolEdit.bypass.setBypass(pinnedChild, true, {
      silent: true,
    });

    try {
      currentSession().approvals.toolEdit.bypass.setBypass(parent, false);

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
      expect(
        currentSession().approvals.toolEdit.bypass.isBypassed(pinnedChild),
      ).toBe(true);
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

    currentSession().approvals.setDelegatedWorkBypasses(roundOne, true);
    currentSession().approvals.registerStreamParent(roundTwo, roundOne);

    expect(proposalApprovals().isBypassed(roundTwo)).toBe(true);
    expect(
      currentSession().approvals.toolEdit.bypass.isBypassed(roundTwo),
    ).toBe(true);
    expect(currentSession().approvals.bash.bypass.isBypassed(roundTwo)).toBe(
      true,
    );

    // An explicit toggle on the later round still wins over the inherited one.
    currentSession().approvals.bash.bypass.setBypass(roundTwo, false, {
      silent: true,
    });
    expect(currentSession().approvals.bash.bypass.isBypassed(roundTwo)).toBe(
      false,
    );
    expect(currentSession().approvals.bash.bypass.isBypassed(roundOne)).toBe(
      true,
    );
    expect(proposalApprovals().isBypassed(roundTwo)).toBe(true);
    expect(
      currentSession().approvals.toolEdit.bypass.isBypassed(roundTwo),
    ).toBe(true);
  });

  it('an explicit child value overrides inherited bypass without touching the parent', () => {
    const { parent, child } = streamPair('toggle');
    currentSession().approvals.bash.bypass.setBypass(parent, true, {
      silent: true,
    });
    configureDelegatedChildApprovals(child, parent);
    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(true);

    currentSession().approvals.bash.bypass.setBypass(child, false);
    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(
      false,
    );
    // The parent's own bypass is untouched by the child's explicit value.
    expect(currentSession().approvals.bash.bypass.isBypassed(parent)).toBe(
      true,
    );
  });

  it('preserves a surviving child state when its parent is torn down', () => {
    const { parent, child } = streamPair('torn-down');
    currentSession().approvals.bash.bypass.setBypass(parent, true, {
      silent: true,
    });
    configureDelegatedChildApprovals(child, parent);
    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(true);

    releaseStreamResources(parent);

    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(true);
    currentSession().approvals.bash.bypass.setBypass(parent, false, {
      silent: true,
    });
    expect(currentSession().approvals.bash.bypass.isBypassed(child)).toBe(true);
  });

  it('pins edit approval for an auto-approved delegation', () => {
    const { parent, child } = streamPair('auto-approved');

    configureDelegatedChildApprovals(child, parent, 'auto-approved');

    expect(currentSession().approvals.toolEdit.bypass.isBypassed(parent)).toBe(
      false,
    );
    expect(currentSession().approvals.toolEdit.bypass.isBypassed(child)).toBe(
      true,
    );
  });

  it('super-YOLO on an inheriting child pins its own edit bypass', () => {
    // `setDelegatedWorkBypasses` must write the child's own explicit
    // tool-edit entry even when `isBypassed` already reports true via
    // ancestry — otherwise the grant silently evaporates when the parent
    // later re-gates its own edits while the child's proposal/bash stay on.
    const { parent, child } = streamPair('pin');
    currentSession().approvals.toolEdit.bypass.setBypass(parent, true, {
      silent: true,
    });
    configureDelegatedChildApprovals(child, parent);
    expect(currentSession().approvals.toolEdit.bypass.isBypassed(child)).toBe(
      true,
    );

    currentSession().approvals.setDelegatedWorkBypasses(child, true);
    currentSession().approvals.toolEdit.bypass.setBypass(parent, false, {
      silent: true,
    });

    expect(currentSession().approvals.toolEdit.bypass.isBypassed(child)).toBe(
      true,
    );
    expect(currentSession().approvals.toolEdit.bypass.isBypassed(parent)).toBe(
      false,
    );
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
});
