// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - command catalog accelerators
import { toElectronAccelerator } from '@shared/commands/accelerators';

describe('desktop command surface', () => {
  it('normalizes catalog keybindings to Electron accelerators', () => {
    expect(
      toElectronAccelerator(
        { key: 'ctrl+alt+shift+c', mac: 'cmd+option+shift+c' },
        'darwin',
      ),
    ).toBe('Command+Option+Shift+C');
    expect(
      toElectronAccelerator(
        { key: 'ctrl+alt+shift+c', mac: 'cmd+option+shift+c' },
        'linux',
      ),
    ).toBe('Control+Alt+Shift+C');
  });
});
