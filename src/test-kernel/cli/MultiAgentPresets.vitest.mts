import { describe, expect, it } from 'vitest';

import {
  cliMultiAgentPresets,
  findCliMultiAgentPreset,
  formatCliMultiAgentPresetDetails,
  formatCliMultiAgentPresetList,
  parseCliCustomAgentPresets,
} from '../../../packages/cli/src/runtime/multiAgentPresets';

describe('CLI multi-agent presets', () => {
  it('lists built-in team presets with stable counts', () => {
    const presets = cliMultiAgentPresets(undefined);

    expect(presets.map((preset) => preset.id)).toContain('physicist');
    expect(formatCliMultiAgentPresetList(presets)).toContain(
      'built-in\tphysicist\tPhysicist\tworkflow:4\ttool-use:9',
    );
  });

  it('parses valid custom team presets and ignores invalid state', () => {
    const valid = [
      {
        id: 'custom-paper',
        name: 'Paper Team',
        description: 'For this paper',
        icon: 'codicon-bookmark',
        workflowAgents: ['polish'],
        toolUseAgents: ['review'],
      },
    ];

    expect(parseCliCustomAgentPresets(valid)).toEqual(valid);
    expect(parseCliCustomAgentPresets([{ id: 'broken' }])).toEqual([]);
  });

  it('finds presets by id, name, or slugified name', () => {
    const presets = cliMultiAgentPresets(undefined);

    expect(findCliMultiAgentPreset(presets, 'PHYSICIST')?.name).toBe(
      'Physicist',
    );
    expect(findCliMultiAgentPreset(presets, 'physicist')?.name).toBe(
      'Physicist',
    );
    expect(findCliMultiAgentPreset(presets, 'Lean Project')?.id).toBe(
      'lean-project',
    );
    expect(
      findCliMultiAgentPreset(presets, 'computer-scientist-(ml)')?.id,
    ).toBe('cs-ml');
  });

  it('formats details without dropping empty agent categories', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    );

    expect(formatCliMultiAgentPresetDetails(preset!)).toContain(
      'Workflow agents:\n  (none)',
    );
    expect(formatCliMultiAgentPresetDetails(preset!)).toContain(
      'Tool-use agents:\n  lean',
    );
  });
});
