import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCliStateStores } from '@cli/runtime/cliStateStores';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

describe('CLI state stores', () => {
  it('persists workspace state across store instances', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-state-'));
    const workspacePath = path.join(root, 'project');
    const preset = {
      id: 'custom-paper',
      name: 'Paper Team',
      description: 'For this paper',
      icon: 'codicon-bookmark',
      workflowAgents: ['polish'],
      toolUseAgents: ['review'],
    };

    try {
      const first = await createCliStateStores({
        storageRoot: path.join(root, 'storage'),
        workspacePath,
      });
      await first.workspaceState.update(
        WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
        [preset],
      );

      const second = await createCliStateStores({
        storageRoot: path.join(root, 'storage'),
        workspacePath,
      });

      expect(
        second.workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
      ).toEqual([preset]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
