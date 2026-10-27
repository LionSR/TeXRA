import { strict as assert } from 'node:assert';

import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { describe } from 'vitest';

import { WorkspaceAgentsController } from '@agent/workspaceAgents/WorkspaceAgentsController';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { agentMatchesIdentifier, parseAgentModePresets } from '@shared/schemas';
import type { AgentModePreset } from '@shared/schemas';
import { FakeStateStore } from '@test/support/FakePlatform';
import { SettingsAgentCatalogController } from '@texra/controllers/settingsView/SettingsAgentCatalogController';

/** The catalog consumes the native agent list and the same entry lookup. */
type SettingsAgentCatalogEntry = ReturnType<
  ConstructorParameters<typeof SettingsAgentCatalogController>[0]['getAgents']
>[0];

const AGENTS: SettingsAgentCatalogEntry[] = [
  {
    source: 'plugin',
    name: 'writer',
    blocks: {},
    description: 'Plugin writer',
  },
  {
    source: 'builtIn',
    name: 'correct',
    blocks: {},
    path: '/agents/correct.yaml',
  },
  {
    source: 'builtIn',
    name: 'review',
    blocks: {},
    path: '/tools/review.yaml',
    tools: ['grep'],
  },
  {
    source: 'custom',
    name: 'customTool',
    blocks: {},
    path: '/custom/customTool.yaml',
  },
];

// Raw persisted records that fail current validation but must survive
// save/delete round-trips untouched.
const LEGACY_ICON_PRESET = {
  id: 'legacy-team',
  name: 'Legacy Team',
  description: 'test',
  icon: 'future-icon',
  agents: ['review'],
};
const MALFORMED_PRESET = { id: 'broken' };

function createController(customPresets: unknown) {
  const getAgents = () => AGENTS;
  const workspaceState = new FakeStateStore({
    [WorkspaceStateKey.CUSTOM_TEAMS]: customPresets,
  });
  const workspaceAgents = new WorkspaceAgentsController({
    repoState: workspaceState,
    globalState: new FakeStateStore(),
    getAgents,
    resolveAgent: (identifier) =>
      AGENTS.find((entry) => agentMatchesIdentifier(entry, identifier)),
    getPresets: () =>
      workspaceState
        .get(WorkspaceStateKey.CUSTOM_TEAMS)
        .pipe(Effect.map(parseAgentModePresets)),
  });
  return {
    controller: new SettingsAgentCatalogController({
      repoState: workspaceState,
      workspaceAgents,
      getAgents,
      newerBuiltInOf: () => undefined,
    }),
    customPresets: workspaceState
      .get(WorkspaceStateKey.CUSTOM_TEAMS)
      .pipe(Effect.map((stored) => (stored ?? []) as unknown[])),
  };
}

describe('SettingsAgentCatalogController', () => {
  it.effect(
    'preserves unrecognized persisted records when saving a preset',
    () =>
      Effect.gen(function* () {
        const state = createController([LEGACY_ICON_PRESET, MALFORMED_PRESET]);

        yield* state.controller.saveCurrentPreset('New Team');

        assert.deepEqual((yield* state.customPresets).slice(0, 2), [
          LEGACY_ICON_PRESET,
          MALFORMED_PRESET,
        ]);
        assert.equal(
          ((yield* state.customPresets)[2] as AgentModePreset | undefined)?.id,
          'custom-0',
        );
      }),
  );
});
