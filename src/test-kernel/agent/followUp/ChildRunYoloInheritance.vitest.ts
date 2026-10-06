// Third-party imports
import { describe, expect, it } from 'vitest';

import { goalGrant, humanGrant } from '@agent/runtime/runApprovalQueue';
import { RUN_PHASE, type RunId } from '@shared/schemas';
import type { RunView, SessionView } from '@shared/session/sessionView';

// Local imports
import {
  NO_APPROVAL_GRANTS,
  type ApprovalGrants,
} from '@shared/approvalBypassKind';
import {
  inheritedGrants,
  resolveBypass,
  runBypasses,
} from '@shared/approvalBypassKind';
import { delegatedChildGrants } from '@tools/approval';

/** A session's grants as its rows fold them: parent edges, each run's
 *  standing and its latest grants. Every run is live unless `interrupted`. */
function rows(
  runs: Record<
    string,
    { parent?: string; grants?: ApprovalGrants; interrupted?: true }
  >,
): Pick<SessionView, 'runs' | 'policy'> {
  return {
    runs: new Map(
      Object.entries(runs).map(([id, run]) => [
        id as RunId,
        {
          parentId: (run.parent ?? null) as RunId | null,
          group: run.interrupted ? 'interrupted' : 'active',
          status: RUN_PHASE.RUNNING,
          substate: null,
        } as RunView,
      ]),
    ),
    policy: new Map(
      Object.entries(runs).flatMap(([id, run]) =>
        run.grants === undefined ? [] : [[id as RunId, run.grants] as const],
      ),
    ),
  };
}

const edits = humanGrant(['toolEdit'], true)(NO_APPROVAL_GRANTS);
const commands = humanGrant(['bash'], true)(NO_APPROVAL_GRANTS);

describe('child subagent stream approval inheritance', () => {
  it('reads the parent tool-edit bypass on the child, and only that kind', () => {
    const view = rows({
      parent: { grants: edits },
      child: { parent: 'parent' },
    });
    expect(resolveBypass(view, 'child' as RunId, 'toolEdit')).toBe('human');
    expect(resolveBypass(view, 'child' as RunId, 'bash')).toBeNull();
  });

  it('leaves the child gated when the parent still prompts', () => {
    const view = rows({ parent: {}, child: { parent: 'parent' } });
    expect(runBypasses(view, 'child' as RunId)).toEqual({
      bash: false,
      toolEdit: false,
      superYolo: false,
    });
  });

  it('follows a parent change made after the child started, with no row of its own', () => {
    const before = rows({ parent: {}, child: { parent: 'parent' } });
    expect(resolveBypass(before, 'child' as RunId, 'bash')).toBeNull();
    const after = rows({
      parent: { grants: commands },
      child: { parent: 'parent' },
    });
    expect(resolveBypass(after, 'child' as RunId, 'bash')).toBe('human');
  });

  it('lets an explicit child value override what it inherits', () => {
    const view = rows({
      parent: { grants: edits },
      child: {
        parent: 'parent',
        grants: humanGrant(['toolEdit'], false)(NO_APPROVAL_GRANTS),
      },
    });
    expect(resolveBypass(view, 'child' as RunId, 'toolEdit')).toBeNull();
    expect(resolveBypass(view, 'parent' as RunId, 'toolEdit')).toBe('human');
  });

  it("carries a goal's grant to descendants while the edge stands, never past it", () => {
    const goal = goalGrant(['bash'])(NO_APPROVAL_GRANTS);
    const view = rows({
      parent: { grants: goal },
      child: { parent: 'parent' },
    });
    expect(resolveBypass(view, 'child' as RunId, 'bash')).toBe('goal');
    expect(inheritedGrants(view, 'child' as RunId)).toEqual(NO_APPROVAL_GRANTS);
  });

  it("keeps the human values a detached child or a conversation's next round inherited", () => {
    const view = rows({
      root: { grants: commands },
      parent: { parent: 'root', grants: edits },
      child: { parent: 'parent' },
    });
    expect(inheritedGrants(view, 'child' as RunId)).toEqual({
      own: { toolEdit: 'on', bash: 'on' },
      goal: [],
    });
  });

  it("follows the parent's later human value past a goal a resume ended (#13839)", () => {
    // The child's activation ended its parent's goal grant for it: derived,
    // not a human's `off`.
    const resumed: ApprovalGrants = { own: { bash: 'parent' }, goal: [] };
    const underGoal = rows({
      parent: { grants: goalGrant(['bash'])(NO_APPROVAL_GRANTS) },
      child: { parent: 'parent', grants: resumed },
    });
    expect(resolveBypass(underGoal, 'child' as RunId, 'bash')).toBeNull();
    const humanOn = rows({
      parent: { grants: commands },
      child: { parent: 'parent', grants: resumed },
    });
    expect(resolveBypass(humanOn, 'child' as RunId, 'bash')).toBe('human');
    expect(inheritedGrants(humanOn, 'child' as RunId).own).toEqual({
      bash: 'on',
    });
  });

  it("ends a goal's grant of a kind a human decides", () => {
    const goal = goalGrant(['bash', 'toolEdit'])(NO_APPROVAL_GRANTS);
    expect(humanGrant(['bash'], false)(goal)).toEqual({
      own: { bash: 'off' },
      goal: ['toolEdit'],
    });
  });

  it('registers an approved delegation with its own grant', () => {
    expect(delegatedChildGrants('inherit')).toEqual(NO_APPROVAL_GRANTS);
    expect(delegatedChildGrants('auto-approved')).toEqual({
      own: { toolEdit: 'on' },
      goal: [],
    });
    expect(delegatedChildGrants('goal-approved')).toEqual({
      own: {},
      goal: ['toolEdit'],
    });
  });

  it('propagates delegated-task approval through nested orchestrators', () => {
    const view = rows({
      root: { grants: humanGrant(['superYolo'], true)(NO_APPROVAL_GRANTS) },
      middle: { parent: 'root' },
      leaf: { parent: 'middle' },
    });
    expect(resolveBypass(view, 'leaf' as RunId, 'superYolo')).toBe('human');
  });
});
