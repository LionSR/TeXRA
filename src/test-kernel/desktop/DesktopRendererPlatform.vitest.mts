// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test support
import { loadSourceModule } from './loadSourceModule.mjs';

function rendererWindow(platform: string): Window {
  return { navigator: { platform } } as unknown as Window;
}

describe('desktop renderer platform', () => {
  it('derives platform values from renderer navigator data', async () => {
    const { getRendererPlatform } = await loadSourceModule(
      '@desktop/renderer/rendererPlatform',
    );

    expect(getRendererPlatform(rendererWindow('MacIntel'))).toBe('darwin');
    expect(getRendererPlatform(rendererWindow('Win32'))).toBe('win32');
    expect(getRendererPlatform(rendererWindow('Linux x86_64'))).toBe('linux');
  });
});
