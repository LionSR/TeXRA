import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_MODE_PRESETS,
  parseAgentModePresets,
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

describe('parseAgentModePresets icon degradation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const customPreset = (icon: string, id = 'custom-1'): unknown => ({
    id,
    name: 'My Team',
    description: 'Hand-saved roster',
    icon,
    workflowAgents: ['polish'],
    toolUseAgents: ['assistant'],
  });

  it('keeps a preset whose icon is unknown, degrading to bookmark loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const presets = parseAgentModePresets([customPreset('nonexistent-icon')]);

    // Regression: the preset itself must survive. Rejecting the icon dropped
    // the whole team, and the next save/delete rewrote the parsed list back
    // over persisted state — permanent data loss.
    expect(presets).toHaveLength(1);
    expect(presets[0]?.id).toBe('custom-1');
    expect(presets[0]?.workflowAgents).toEqual(['polish']);
    expect(presets[0]?.icon).toBe('bookmark');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('nonexistent-icon'),
    );
  });

  it('does not drop sibling presets when one icon is unknown', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const presets = parseAgentModePresets([
      customPreset('rocket'),
      customPreset('bogus', 'custom-2'),
    ]);

    expect(presets.map((preset) => preset.id)).toEqual([
      'custom-1',
      'custom-2',
    ]);
    expect(presets.map((preset) => preset.icon)).toEqual([
      'rocket',
      'bookmark',
    ]);
  });

  it('degrades codicon-prefixed obsolete icons with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const presets = parseAgentModePresets([customPreset('codicon-tools')]);

    // 'tools' was removed from canonical icons — falls back to bookmark with warning
    expect(presets[0]?.icon).toBe('bookmark');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tools'));
  });
});
