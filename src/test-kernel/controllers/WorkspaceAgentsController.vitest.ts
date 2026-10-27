import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import {
  WorkspaceAgentsController,
  type WorkspaceAgentsControllerDeps,
  type WorkspaceAgentsEntry,
} from '@agent/workspaceAgents/WorkspaceAgentsController';
import type { StateStore } from '@platform/interfaces';
import { agentMatchesIdentifier } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

const agents: WorkspaceAgentsEntry[] = [
  { source: 'builtIn', name: 'write' },
  { source: 'custom', name: 'review' },
  { source: 'builtIn', name: 'lead' },
  { source: 'custom', name: 'search' },
];

function controller(
  workspaceState: StateStore,
  overrides: Partial<WorkspaceAgentsControllerDeps> = {},
): WorkspaceAgentsController {
  const getAgents = overrides.getAgents ?? (() => agents);
  return new WorkspaceAgentsController({
    repoState: workspaceState,
    globalState: new FakeStateStore(),
    getAgents,
    resolveAgent: (identifier) =>
      getAgents().find((entry) => agentMatchesIdentifier(entry, identifier)),
    ...overrides,
  });
}

describe('WorkspaceAgentsController', () => {
  it.effect(
    'refuses a toggle over a malformed hidden list instead of rewriting it',
    () =>
      Effect.gen(function* () {
        // One empty key fails the list's schema; a write built from the
        // default would erase every other stored choice.
        const stored = ['custom:review', ''];
        const workspaceState = new FakeStateStore({
          [WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS]: stored,
        });
        const workspaceAgents = controller(workspaceState, {
          getAgents: () => [],
        });

        const failure = yield* Effect.flip(
          workspaceAgents.setEnabledAgentKeys([]),
        );
        expect(failure._tag).toBe('StateReadFailed');
        expect(
          yield* workspaceState.get(WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS),
        ).toEqual(stored);
      }),
  );

  it.effect('serializes concurrent toggles through one workspace owner', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const first = controller(workspaceState);
      const second = controller(workspaceState);
      yield* first.setAll();

      yield* Effect.all(
        [
          first.setAgentEnabled({
            source: 'custom',
            name: 'review',
            enabled: false,
          }),
          second.setAgentEnabled({
            source: 'custom',
            name: 'search',
            enabled: false,
          }),
        ],
        { concurrency: 'unbounded' },
      );

      expect((yield* first.snapshot()).selection).toEqual({
        kind: 'custom',
        agentKeys: ['builtIn:write', 'builtIn:lead'],
      });
    }),
  );
});
