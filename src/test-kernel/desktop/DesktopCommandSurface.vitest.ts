// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - command catalog and shared schemas
import {
  formatDesktopAccelerator,
  toElectronAccelerator,
} from '@shared/commands/accelerators';

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

  it('formats accelerators for desktop tooltip display', () => {
    expect(formatDesktopAccelerator('Command+Option+M', 'darwin')).toBe('⌘⌥M');
    expect(formatDesktopAccelerator('Control+O', 'linux')).toBe('Ctrl+O');
    expect(formatDesktopAccelerator('Control+Alt+Shift+C', 'linux')).toBe(
      'Ctrl+Alt+Shift+C',
    );
    expect(formatDesktopAccelerator(undefined, 'darwin')).toBeUndefined();
  });
});
