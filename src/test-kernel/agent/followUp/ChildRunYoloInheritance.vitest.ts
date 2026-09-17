// Test composition imports

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports

import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import type { RunId } from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import {
  configureDelegatedChildApprovals,
  proposalApprovals,
  releaseRunResources,
} from '@tools/approval';
import { generateRunId } from '@utils/core';

function runPair(): {
  parent: RunId;
  child: RunId;
} {
  return { parent: generateRunId(), child: generateRunId() };
}

describe('child subagent stream approval inheritance', () => {
  afterEach(() => {
    testDefaultSession().approvals.clearAll();
  });

  it('mirrors the parent tool-edit bypass onto the child stream', () => {
    const { parent, child } = runPair();
    testDefaultSession().approvals.toolEdit.bypass.setBypass(parent, true, {
      silent: true,
    });

    configureDelegatedChildApprovals(
      child,
      parent,
      undefined,
      testDefaultSession(),
    );

    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(child),
    ).toBe(true);
    // Edit-YOLO inheritance must not drag bash along — bypass values stay independent.
    expect(testDefaultSession().approvals.bash.bypass.isBypassed(child)).toBe(
      false,
    );
  });

  it('leaves the child gated when the parent still prompts', () => {
    const { parent, child } = runPair();

    configureDelegatedChildApprovals(
      child,
      parent,
      undefined,
      testDefaultSession(),
    );

    expect(testDefaultSession().approvals.bash.bypass.isBypassed(child)).toBe(
      false,
    );
    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(child),
    ).toBe(false);
  });

  it('mirrors bash independently of tool-edit YOLO (CLI AUTO-BASH, no AUTO-APPROVE)', () => {
    // The bug this guards against: a parent with bash auto-approved but edits
    // still gated must propagate bash to the child without also granting the
    // child tool-edit YOLO.
    const { parent, child } = runPair();
    testDefaultSession().approvals.bash.bypass.setBypass(parent, true, {
      silent: true,
    });

    configureDelegatedChildApprovals(
      child,
      parent,
      undefined,
      testDefaultSession(),
    );

    expect(testDefaultSession().approvals.bash.bypass.isBypassed(child)).toBe(
      true,
    );
    // The parent's edits are gated, so the child's stay gated too.
    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(child),
    ).toBe(false);
  });

  it('picks up a parent bash bypass toggled after the child stream already started', () => {
    // Regression for the "YOLO forgotten after one round" bug: inheritance
    // used to be a one-shot copy taken at child-creation time, so a bypass
    // enabled on the parent afterwards never reached an already-running
    // child. It must now resolve live off the ancestry link.
    const { parent, child } = runPair();

    configureDelegatedChildApprovals(
      child,
      parent,
      undefined,
      testDefaultSession(),
    );
    expect(testDefaultSession().approvals.bash.bypass.isBypassed(child)).toBe(
      false,
    );

    testDefaultSession().approvals.bash.bypass.setBypass(parent, true, {
      silent: true,
    });

    expect(testDefaultSession().approvals.bash.bypass.isBypassed(child)).toBe(
      true,
    );
  });

  it('picks up a parent edit-YOLO toggled after the child stream already started', () => {
    // The extension's one shield couples edit + bash bypass; flipping it on
    // while delegated children are already running must reach their edits
    // exactly like it reaches their bash. Tool-edit inheritance used to be a
    // one-shot grant at delegation launch, so a mid-run toggle left children
    // prompting for every edit.
    const { parent, child } = runPair();

    configureDelegatedChildApprovals(
      child,
      parent,
      undefined,
      testDefaultSession(),
    );
    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(child),
    ).toBe(false);

    testDefaultSession().approvals.toolEdit.bypass.setBypass(parent, true, {
      silent: true,
    });
    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(child),
    ).toBe(true);

    // And back off: the child follows the parent's current state, not a
    // snapshot taken at delegation time.
    testDefaultSession().approvals.toolEdit.bypass.setBypass(parent, false, {
      silent: true,
    });
    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(child),
    ).toBe(false);
  });

  it('reports every visible descendant whose inherited edit bypass moved', () => {
    // The one channel this state travels: `onPolicyChanged`, which the
    // session layer binds to `publishApprovalPolicy`, so each reported run
    // becomes that run's `approval.policy` row.
    const changed: RunId[] = [];
    const approvals = createSessionApprovals((runId) => changed.push(runId));
    const { parent, child } = runPair();
    const grandchild = generateRunId();
    const pinnedChild = generateRunId();
    approvals.toolEdit.bypass.setBypass(parent, true, { silent: true });
    approvals.registerRunParent(child, parent);
    approvals.registerRunParent(grandchild, child);
    approvals.registerRunParent(pinnedChild, parent);
    approvals.toolEdit.bypass.setBypass(pinnedChild, true, { silent: true });
    changed.length = 0;

    approvals.toolEdit.bypass.setBypass(parent, false);

    expect(changed).toEqual([parent, child, grandchild]);
    expect(approvals.toolEdit.bypass.isBypassed(pinnedChild)).toBe(true);
  });

  it('lets a conversation round inherit bypass from the previous round via the session-level ancestry link', () => {
    // Mirrors the CLI: every chat round mints a brand-new root RunId,
    // so bypass must be carried forward explicitly (see
    // chatSessionController.ts's onRunResolved) rather than assumed to
    // survive on the same stream id.
    const roundOne = generateRunId();
    const roundTwo = generateRunId();

    testDefaultSession().approvals.setDelegatedWorkBypasses(roundOne, true);
    testDefaultSession().approvals.registerRunParent(roundTwo, roundOne);

    expect(proposalApprovals(testDefaultSession()).isBypassed(roundTwo)).toBe(
      true,
    );
    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(roundTwo),
    ).toBe(true);
    expect(
      testDefaultSession().approvals.bash.bypass.isBypassed(roundTwo),
    ).toBe(true);

    // An explicit toggle on the later round still wins over the inherited one.
    testDefaultSession().approvals.bash.bypass.setBypass(roundTwo, false, {
      silent: true,
    });
    expect(
      testDefaultSession().approvals.bash.bypass.isBypassed(roundTwo),
    ).toBe(false);
    expect(
      testDefaultSession().approvals.bash.bypass.isBypassed(roundOne),
    ).toBe(true);
    expect(proposalApprovals(testDefaultSession()).isBypassed(roundTwo)).toBe(
      true,
    );
    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(roundTwo),
    ).toBe(true);
  });

  it('an explicit child value overrides inherited bypass without touching the parent', () => {
    const { parent, child } = runPair();
    testDefaultSession().approvals.bash.bypass.setBypass(parent, true, {
      silent: true,
    });
    configureDelegatedChildApprovals(
      child,
      parent,
      undefined,
      testDefaultSession(),
    );
    expect(testDefaultSession().approvals.bash.bypass.isBypassed(child)).toBe(
      true,
    );

    testDefaultSession().approvals.bash.bypass.setBypass(child, false);
    expect(testDefaultSession().approvals.bash.bypass.isBypassed(child)).toBe(
      false,
    );
    // The parent's own bypass is untouched by the child's explicit value.
    expect(testDefaultSession().approvals.bash.bypass.isBypassed(parent)).toBe(
      true,
    );
  });

  it('preserves a surviving child state when its parent is torn down', () => {
    const { parent, child } = runPair();
    testDefaultSession().approvals.bash.bypass.setBypass(parent, true, {
      silent: true,
    });
    configureDelegatedChildApprovals(
      child,
      parent,
      undefined,
      testDefaultSession(),
    );
    expect(testDefaultSession().approvals.bash.bypass.isBypassed(child)).toBe(
      true,
    );

    releaseRunResources(parent, testDefaultSession());

    expect(testDefaultSession().approvals.bash.bypass.isBypassed(child)).toBe(
      true,
    );
    testDefaultSession().approvals.bash.bypass.setBypass(parent, false, {
      silent: true,
    });
    expect(testDefaultSession().approvals.bash.bypass.isBypassed(child)).toBe(
      true,
    );
  });

  it('pins edit approval for an auto-approved delegation', () => {
    const { parent, child } = runPair();

    configureDelegatedChildApprovals(
      child,
      parent,
      'auto-approved',
      testDefaultSession(),
    );

    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(parent),
    ).toBe(false);
    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(child),
    ).toBe(true);
  });

  it('super-YOLO on an inheriting child pins its own edit bypass', () => {
    // `setDelegatedWorkBypasses` must write the child's own explicit
    // tool-edit entry even when `isBypassed` already reports true via
    // ancestry — otherwise the grant silently evaporates when the parent
    // later re-gates its own edits while the child's proposal/bash stay on.
    const { parent, child } = runPair();
    testDefaultSession().approvals.toolEdit.bypass.setBypass(parent, true, {
      silent: true,
    });
    configureDelegatedChildApprovals(
      child,
      parent,
      undefined,
      testDefaultSession(),
    );
    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(child),
    ).toBe(true);

    testDefaultSession().approvals.setDelegatedWorkBypasses(child, true);
    testDefaultSession().approvals.toolEdit.bypass.setBypass(parent, false, {
      silent: true,
    });

    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(child),
    ).toBe(true);
    expect(
      testDefaultSession().approvals.toolEdit.bypass.isBypassed(parent),
    ).toBe(false);
  });

  it('propagates delegated-task approval through nested orchestrators', () => {
    const { parent, child } = runPair();
    const grandchild = generateRunId();
    proposalApprovals(testDefaultSession()).setBypass(parent, true);

    configureDelegatedChildApprovals(
      child,
      parent,
      undefined,
      testDefaultSession(),
    );
    configureDelegatedChildApprovals(
      grandchild,
      child,
      undefined,
      testDefaultSession(),
    );

    expect(proposalApprovals(testDefaultSession()).isBypassed(parent)).toBe(
      true,
    );
    expect(proposalApprovals(testDefaultSession()).isBypassed(child)).toBe(
      true,
    );
    expect(proposalApprovals(testDefaultSession()).isBypassed(grandchild)).toBe(
      true,
    );
  });
});
