import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCliStateStores } from '@cli/runtime/cliStateStores';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

describe('CLI state stores', () => {
  const tempDirs = useTempDirs();

  it('persists workspace state across store instances', async () => {
    const root = await makeTempDir('texra-cli-state-', tempDirs);
    const workspacePath = path.join(root, 'project');
    const preset = {
      id: 'custom-paper',
      name: 'Paper Team',
      description: 'For this paper',
      icon: 'codicon-bookmark',
      agents: { workflow: ['polish'], toolUse: ['review'] },
    };

    const first = await createCliStateStores({
      storageRoot: path.join(root, 'storage'),
      workspacePath,
    });
    await first.workspaceState.update(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [
      preset,
    ]);

    const second = await createCliStateStores({
      storageRoot: path.join(root, 'storage'),
      workspacePath,
    });

    expect(
      second.workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
    ).toEqual([preset]);
  });
});
