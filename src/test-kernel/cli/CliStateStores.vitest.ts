// Node imports
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { openCliWorkspaceState } from '@cli/runtime/cliStateStores';
import { projectDatabaseLayer } from '@controllers/session/projectDatabase';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

describe('CLI state stores', () => {
  const tempDirs = useTempDirs();

  it.live('persists workspace state across store instances', () =>
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

      const first = yield* openCliWorkspaceState({
        storageRoot: path.join(root, 'storage'),
        workspacePath,
      });
      yield* first.workspaceState.update(
        WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
        [preset],
      );

      const second = yield* openCliWorkspaceState({
        storageRoot: path.join(root, 'storage'),
        workspacePath,
      });

      expect(
        yield* second.workspaceState.get(
          WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
        ),
      ).toEqual([preset]);
    }).pipe(
      Effect.scoped,
      Effect.provide(projectDatabaseLayer),
      Effect.provide(
        ProcessIdentity.layer('["test-host",4242,"cli-state-test"]'),
      ),
    ),
  );
});
