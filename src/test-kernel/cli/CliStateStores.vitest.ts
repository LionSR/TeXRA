// Node imports
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { createCliStateStores } from '@cli/runtime/cliStateStores';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

describe('CLI state stores', () => {
  const tempDirs = useTempDirs();

  it.effect('persists workspace state across store instances', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        makeTempDir('texra-cli-state-', tempDirs),
      );
      const workspacePath = path.join(root, 'project');
      const preset = {
        id: 'custom-paper',
        name: 'Paper Team',
        description: 'For this paper',
        icon: 'bookmark',
        agents: { workflow: ['polish'], toolUse: ['review'] },
      };

      const first = yield* createCliStateStores({
        storageRoot: path.join(root, 'storage'),
        workspacePath,
        runWrite: (write) => Effect.runPromise(write),
      });
      yield* Effect.promise(() =>
        first.workspaceState.update(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [
          preset,
        ]),
      );

      const second = yield* createCliStateStores({
        storageRoot: path.join(root, 'storage'),
        workspacePath,
        runWrite: (write) => Effect.runPromise(write),
      });

      expect(
        second.workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
      ).toEqual([preset]);
    }),
  );
});
