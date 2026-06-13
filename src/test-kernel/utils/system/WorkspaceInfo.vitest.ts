import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildWorkspaceInfoBlock } from '@utils/system/workspaceInfo';

describe('buildWorkspaceInfoBlock', () => {
  it('tells agents when the workspace is not a git repository', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'texra-workspace-info-'));
    try {
      const block = await buildWorkspaceInfoBlock(workspace);

      expect(block).toContain(`Workspace: ${workspace}`);
      expect(block).toContain(
        'Git: no repository detected or git could not be checked',
      );
      expect(block).toContain('avoid git history/status checks');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
