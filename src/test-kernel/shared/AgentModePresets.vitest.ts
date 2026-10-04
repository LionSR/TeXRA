import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAgentModePresets } from '@shared/schemas';

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
      description: 'Hand-saved agent list',
      icon,
      agents: ['polish', 'assistant'],
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
