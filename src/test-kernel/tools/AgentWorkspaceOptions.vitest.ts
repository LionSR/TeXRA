import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAgentWorkspaceOptions } from '@tools/agentWorkspaceOptions';
import { WorkspaceFS } from '@utils/files/workspaceFS';

describe('agent workspace options', () => {
  beforeEach(() => {
    vi.spyOn(WorkspaceFS, 'getPath').mockReturnValue('/tmp/workspace');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to the workspace root when no working directory is provided', () => {
    expect(buildAgentWorkspaceOptions()).toEqual({
      workingDirectory: '/tmp/workspace',
    });
  });

  it('keeps the workspace root available for subdirectory runs', () => {
    expect(buildAgentWorkspaceOptions('packages/app')).toEqual({
      workingDirectory: path.resolve('/tmp/workspace', 'packages/app'),
      additionalDirectories: ['/tmp/workspace'],
    });
  });

  it('does not add the current workspace for external worktree paths', () => {
    expect(buildAgentWorkspaceOptions('/tmp/worktrees/feature-a')).toEqual({
      workingDirectory: '/tmp/worktrees/feature-a',
    });
  });
});
