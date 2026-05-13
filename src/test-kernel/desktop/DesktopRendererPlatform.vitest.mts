// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopRendererPlatformModule {
  getRendererPlatform(view: Window | null): NodeJS.Platform;
}

async function loadDesktopRendererPlatform(): Promise<DesktopRendererPlatformModule> {
  return import(
    moduleFileUrl(desktopSourcePath('renderer', 'rendererPlatform.ts'))
  ) as Promise<DesktopRendererPlatformModule>;
}

function rendererWindow(platform: string): Window {
  return { navigator: { platform } } as unknown as Window;
}

describe('desktop renderer platform', () => {
  it('derives platform values from renderer navigator data', async () => {
    const { getRendererPlatform } = await loadDesktopRendererPlatform();

    expect(getRendererPlatform(rendererWindow('MacIntel'))).toBe('darwin');
    expect(getRendererPlatform(rendererWindow('Win32'))).toBe('win32');
    expect(getRendererPlatform(rendererWindow('Linux x86_64'))).toBe('linux');
  });
});
