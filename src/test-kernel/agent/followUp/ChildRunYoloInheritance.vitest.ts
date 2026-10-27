// Third-party imports
import { describe, expect, it } from 'vitest';

import { goalGrant, humanGrant } from '@agent/runtime/runApprovalQueue';
import { RUN_PHASE, type RunId } from '@shared/schemas';
import type { RunView, SessionView } from '@shared/session/sessionView';

// Local imports
import {
  NO_APPROVAL_GRANTS,
  type ApprovalGrants,
  inheritedGrants,
  resolveBypass,
} from '@shared/approvalBypassKind';

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

const commands = humanGrant(['bash'], true)(NO_APPROVAL_GRANTS);

describe('child subagent stream approval inheritance', () => {
  it("carries a goal's grant to descendants while the edge stands, never past it", () => {
    const goal = goalGrant(['bash'])(NO_APPROVAL_GRANTS);
    const view = rows({
      parent: { grants: goal },
      child: { parent: 'parent' },
    });
    expect(resolveBypass(view, 'child' as RunId, 'bash')).toBe('goal');
    expect(inheritedGrants(view, 'child' as RunId)).toEqual(NO_APPROVAL_GRANTS);
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
});
