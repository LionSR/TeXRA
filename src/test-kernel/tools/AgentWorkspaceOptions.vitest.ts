import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildAgentWorkspaceOptions } from '@tools/agentWorkspaceOptions';

describe('agent workspace options', () => {
  it('defaults to the workspace root when no working directory is provided', () => {
    expect(buildAgentWorkspaceOptions('/tmp/workspace')).toEqual({
      workingDirectory: '/tmp/workspace',
    });
  });

  it('keeps the workspace root available for subdirectory runs', () => {
    expect(
      buildAgentWorkspaceOptions('/tmp/workspace', 'packages/app'),
    ).toEqual({
      workingDirectory: path.resolve('/tmp/workspace', 'packages/app'),
      additionalDirectories: ['/tmp/workspace'],
    });
  });

  it('does not add the current workspace for external worktree paths', () => {
    expect(
      buildAgentWorkspaceOptions('/tmp/workspace', '/tmp/worktrees/feature-a'),
    ).toEqual({ workingDirectory: '/tmp/worktrees/feature-a' });
  });
});
