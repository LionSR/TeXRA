import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_MODE_PRESETS,
  parseAgentModePresets,
  STARTER_AGENT_MODE_PRESET,
} from '@shared/schemas';

describe('agent preset hosted-definition metadata', () => {
  it('keeps every hosted name inside its owning preset roster', () => {
    for (const preset of [STARTER_AGENT_MODE_PRESET, ...AGENT_MODE_PRESETS]) {
      const roster = new Set([
        ...preset.agents.workflow,
        ...preset.agents.toolUse,
      ]);
      expect(
        preset.texraHostedAgents.filter((name) => !roster.has(name)),
        `${preset.id} has hosted metadata outside its roster`,
      ).toEqual([]);
    }
  });
});

describe('parseAgentModePresets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockConsoleWarn() {
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  }

  function customPreset(icon: string, id = 'custom-1'): unknown {
    return {
      id,
      name: 'My Team',
      description: 'Hand-saved roster',
      icon,
      agents: {
        workflow: ['polish'],
        toolUse: ['assistant'],
      },
      texraHostedAgents: [],
    };
  }

  it('warns about a malformed record without dropping valid siblings', () => {
    const warn = mockConsoleWarn();

    const presets = parseAgentModePresets([
      customPreset('rocket'),
      { id: 'incomplete' },
    ]);

    expect(presets.map((preset) => preset.id)).toEqual(['custom-1']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('index 1'));
  });
});
