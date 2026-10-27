import { describe, expect, it } from 'vitest';

import { buildAgentWorkspaceOptions } from '@texra/tools/agentWorkspaceOptions';

describe('agent workspace options', () => {
  // An external CLI agent gets access to exactly the directories it names:
  // a run in another worktree must not be granted the current workspace too.
  it('does not add the current workspace for external worktree paths', () => {
    expect(
      buildAgentWorkspaceOptions('/tmp/workspace', '/tmp/worktrees/feature-a'),
    ).toEqual({
      workingDirectory: '/tmp/worktrees/feature-a',
    });
  });
});
