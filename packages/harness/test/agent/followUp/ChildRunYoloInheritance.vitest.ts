// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  type ApprovalGrants,
  resolveBypass,
  type RunId,
  type RunView,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { goalGrant, humanGrant } from '@agent/runtime/runApprovalQueue';

// Local imports
import {
  NO_APPROVAL_GRANTS,
  inheritedGrants,
} from '@shared/approvalBypassKind';

/** A fixture run id: these suites name runs (`child`, `parent`) rather than
 *  minting hex ids, and the grants under test only compare them. */
// cast: a readable name stands in for a run id the code only compares.
const runId = (name: string): RunId => name as RunId;

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
        runId(id),
        // The bypass reads parentId, holder and outcome, the only fields set here.
        // cast: a partial RunView with the fields the bypass reads.
        {
          parentId: run.parent === undefined ? null : runId(run.parent),
          holder: run.interrupted ? 'none' : 'here',
          position: 'running',
          outcome: null,
        } as RunView,
      ]),
    ),
    policy: new Map(
      Object.entries(runs).flatMap(([id, run]) =>
        run.grants === undefined ? [] : [[runId(id), run.grants] as const],
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
    expect(resolveBypass(view, runId('child'), 'bash')).toBe('goal');
    expect(inheritedGrants(view, runId('child'))).toEqual(NO_APPROVAL_GRANTS);
  });

  it("follows the parent's later human value past a goal a resume ended (#13839)", () => {
    // The child's activation ended its parent's goal grant for it: derived,
    // not a human's `off`.
    const resumed: ApprovalGrants = { own: { bash: 'parent' }, goal: [] };
    const underGoal = rows({
      parent: { grants: goalGrant(['bash'])(NO_APPROVAL_GRANTS) },
      child: { parent: 'parent', grants: resumed },
    });
    expect(resolveBypass(underGoal, runId('child'), 'bash')).toBeNull();
    const humanOn = rows({
      parent: { grants: commands },
      child: { parent: 'parent', grants: resumed },
    });
    expect(resolveBypass(humanOn, runId('child'), 'bash')).toBe('human');
    expect(inheritedGrants(humanOn, runId('child')).own).toEqual({
      bash: 'on',
    });
  });
});
