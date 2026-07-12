import { describe, expect, it } from 'vitest';

import {
  AGENT_MODE_PRESETS,
  STARTER_AGENT_MODE_PRESET,
} from '@shared/schemas/agentPresets';

describe('agent preset hosted-definition metadata', () => {
  it('keeps every hosted name inside its owning preset roster', () => {
    for (const preset of [STARTER_AGENT_MODE_PRESET, ...AGENT_MODE_PRESETS]) {
      const roster = new Set([
        ...preset.workflowAgents,
        ...preset.toolUseAgents,
      ]);
      expect(
        (preset.texraHostedAgents ?? []).filter((name) => !roster.has(name)),
        `${preset.id} has hosted metadata outside its roster`,
      ).toEqual([]);
    }
  });

  it('marks the bundled software-engineer team as local-only', () => {
    const softwareTeam = AGENT_MODE_PRESETS.find(
      (preset) => preset.id === 'software-engineer',
    );

    expect(softwareTeam?.texraHostedAgents).toEqual([]);
  });
});
