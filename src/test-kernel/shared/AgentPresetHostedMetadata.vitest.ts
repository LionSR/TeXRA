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
        (preset.texraHostedAgents ?? []).filter((name) => !roster.has(name)),
        `${preset.id} has hosted metadata outside its roster`,
      ).toEqual([]);
    }
  });

  it('rejects a retired legacy pair-shaped custom team with a warning', () => {
    // The `workflowAgents`/`toolUseAgents` legacy pair (#9705) is retired:
    // such a blob must fail parsing loudly, not silently masquerade as an
    // empty roster.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const presets = parseAgentModePresets([
      {
        id: 'legacy-team',
        name: 'Legacy Team',
        description: 'Saved by an older binary',
        icon: 'bookmark',
        workflowAgents: ['polish', 'correct'],
        toolUseAgents: ['assistant'],
        texraHostedAgents: ['assistant'],
      },
    ]);

    expect(presets).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('index 0'));
    vi.restoreAllMocks();
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
    };
  }

  it('treats an absent custom-preset value as an empty list', () => {
    const warn = mockConsoleWarn();

    expect(parseAgentModePresets(undefined)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when the custom-preset value is malformed', () => {
    const warn = mockConsoleWarn();

    expect(parseAgentModePresets('not-an-array')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not an array'));
  });

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
