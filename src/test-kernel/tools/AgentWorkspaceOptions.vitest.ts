import { describe, expect, it } from 'vitest';

import { buildAgentWorkspaceOptions } from '@tools/agentWorkspaceOptions';

const WORKSPACE = '/tmp/workspace';

describe('agent workspace options', () => {
  it('defaults to the workspace root when no working directory is provided', () => {
    expect(buildAgentWorkspaceOptions(WORKSPACE)).toEqual({
      workingDirectory: '/tmp/workspace',
    });
  });

  it('keeps the workspace root available for subdirectory runs', () => {
    expect(
      buildAgentWorkspaceOptions(WORKSPACE, '/tmp/workspace/packages/app'),
    ).toEqual({
      workingDirectory: '/tmp/workspace/packages/app',
      additionalDirectories: ['/tmp/workspace'],
    });
  });

  it('does not add the current workspace for external worktree paths', () => {
    expect(
      buildAgentWorkspaceOptions(WORKSPACE, '/tmp/worktrees/feature-a'),
    ).toEqual({
      workingDirectory: '/tmp/worktrees/feature-a',
    });
  });
});
