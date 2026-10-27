import { strict as assert } from 'node:assert';

import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { describe } from 'vitest';

import { WorkspaceAgentsController } from '@agent/workspaceAgents/WorkspaceAgentsController';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  agentKeyOf,
  agentMatchesIdentifier,
  parseAgentModePresets,
} from '@shared/schemas';
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

function createController(options?: {
  agents?: SettingsAgentCatalogEntry[];
  visible?: SettingsAgentCatalogEntry[];
  customPresets?: unknown;
}) {
  const getAgents = () => options?.agents ?? AGENTS;
  const workspaceState = new FakeStateStore({
    [WorkspaceStateKey.CUSTOM_TEAMS]: options?.customPresets ?? [],
    // A `visible` agent list is the user's choice: the custom agents it leaves out
    // were turned off.
    ...(options?.visible
      ? {
          [WorkspaceStateKey.WORKSPACE_AGENTS]: {
            kind: 'custom',
            agentKeys: options.visible.map(agentKeyOf),
          },
          [WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS]: getAgents()
            .filter(
              (entry) =>
                entry.source === 'custom' && !options.visible?.includes(entry),
            )
            .map(agentKeyOf),
        }
      : {}),
  });
  const workspaceAgents = new WorkspaceAgentsController({
    repoState: workspaceState,
    globalState: new FakeStateStore(),
    getAgents,
    resolveAgent: (identifier) =>
      getAgents().find((entry) => agentMatchesIdentifier(entry, identifier)),
    getPresets: () =>
      workspaceState
        .get(WorkspaceStateKey.CUSTOM_TEAMS)
        .pipe(Effect.map(parseAgentModePresets)),
  });
  return {
    workspaceAgents,
    controller: new SettingsAgentCatalogController({
      repoState: workspaceState,
      workspaceAgents,
      getAgents,
      newerBuiltInOf: () => undefined,
    }),
    workspaceState,
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
        const state = createController({
          customPresets: [LEGACY_ICON_PRESET, MALFORMED_PRESET],
        });

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
