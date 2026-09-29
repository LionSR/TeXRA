import { it } from '@effect/vitest';
import { describe, expect, vi } from 'vitest';

import { Effect } from 'effect';
import { applyTeamRoster } from '@common/teams/TeamRosterApplication';
import type { AgentModePreset } from '@shared/schemas';

const preset: AgentModePreset = {
  id: 'research',
  name: 'Research',
  description: 'Research team',
  icon: 'bookmark',
  agents: {
    workflow: [],
    toolUse: ['orchestrator'],
  },
};

const unresolved = {
  agentKeys: { workflow: [], toolUse: [] },
  missingAgents: { workflow: [], toolUse: ['orchestrator'] },
};

describe('team roster application', () => {
  it.effect('commits the resolved preset once', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const commitPreset = vi.fn(() =>
        Effect.sync(() => {
          calls.push('commit');
        }),
      );

      const result = yield* applyTeamRoster('research', {
        catalog: {
          resolvePreset: () =>
            Effect.succeed({ ok: true, preset, resolution: unresolved }),
          commitPreset,
        },
      });

      expect(result).toEqual({
        status: 'applied',
        preset,
        resolution: unresolved,
      });
      expect(calls).toEqual(['commit']);
      expect(commitPreset).toHaveBeenCalledWith(preset);
    }),
  );
});
