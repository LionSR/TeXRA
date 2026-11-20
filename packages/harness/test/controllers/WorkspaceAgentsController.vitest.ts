import { it } from '@effect/vitest';
import { Effect, Logger } from 'effect';
import { describe, expect } from 'vitest';

import { agentMatchesIdentifier } from '@texra-ai/harness/schemas';
import { WorkspaceAgentsController } from '@agent/workspaceAgents/WorkspaceAgentsController';
import { FakeStateStore } from '@test/support/FakePlatform';
import type { StateStore } from '@texra-ai/harness/plugins';
import type {
  WorkspaceAgentsControllerDeps,
  WorkspaceAgentsEntry,
} from '@texra-ai/harness/host';
import {
  HIDDEN_CUSTOM_AGENTS_KEY,
  WORKSPACE_AGENTS_KEY,
} from '@agent/workspaceAgents/workspaceAgentsState';

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
          [HIDDEN_CUSTOM_AGENTS_KEY.key]: stored,
        });
        const workspaceAgents = controller(workspaceState, {
          getAgents: () => [],
        });

        const failure = yield* Effect.flip(
          workspaceAgents.select({ kind: 'custom', agentKeys: [] }),
        );
        expect(failure._tag).toBe('StateReadFailed');
        expect(yield* workspaceState.get(HIDDEN_CUSTOM_AGENTS_KEY.key)).toEqual(
          stored,
        );
      }),
  );

  it.effect(
    'reports a stored selection no read decodes when a toggle replaces it',
    () =>
      Effect.gen(function* () {
        // What a build with teams stored. It reads as every agent, so the
        // toggle starts from that list and says the stored value was dropped.
        const workspaceState = new FakeStateStore({
          [WORKSPACE_AGENTS_KEY.key]: { kind: 'team', teamId: 'physics' },
        });
        const warnings: string[] = [];

        yield* controller(workspaceState)
          .setAgentEnabled({ source: 'custom', name: 'review', enabled: false })
          .pipe(
            Effect.provide(
              Logger.layer([
                Logger.make(({ logLevel, message }) => {
                  if (logLevel === 'Warn') warnings.push(String(message));
                }),
              ]),
            ),
          );

        expect(warnings.join('\n')).toContain(WORKSPACE_AGENTS_KEY.key);
        expect(yield* workspaceState.get(WORKSPACE_AGENTS_KEY.key)).toEqual({
          kind: 'custom',
          agentKeys: ['builtIn:write', 'builtIn:lead', 'custom:search'],
        });
      }),
  );

  it.effect('keeps both of two concurrent toggles', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const first = controller(workspaceState);
      const second = controller(workspaceState);
      yield* first.select({ kind: 'all' });

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
