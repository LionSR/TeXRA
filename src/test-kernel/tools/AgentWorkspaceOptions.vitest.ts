// Standard library imports
import * as path from 'path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - tools
import { buildAgentWorkspaceOptions } from '@tools/agentWorkspaceOptions';

// Local imports - files
import { WorkspaceFS } from '@utils/files';

describe('agent workspace options', () => {
  const originalGetPath = WorkspaceFS.getPath;

  afterEach(() => {
    WorkspaceFS.getPath = originalGetPath;
  });

  it('defaults to the workspace root when no working directory is provided', () => {
    WorkspaceFS.getPath = () => '/tmp/workspace';

    expect(buildAgentWorkspaceOptions()).toEqual({
      workingDirectory: '/tmp/workspace',
    });
  });

  it('keeps the workspace root available for subdirectory runs', () => {
    WorkspaceFS.getPath = () => '/tmp/workspace';

    expect(buildAgentWorkspaceOptions('packages/app')).toEqual({
      workingDirectory: path.resolve('/tmp/workspace', 'packages/app'),
      additionalDirectories: ['/tmp/workspace'],
    });
  });

  it('does not add the current workspace for external worktree paths', () => {
    WorkspaceFS.getPath = () => '/tmp/workspace';

    expect(buildAgentWorkspaceOptions('/tmp/worktrees/feature-a')).toEqual({
      workingDirectory: '/tmp/worktrees/feature-a',
    });
  });
});
