// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - shared host bridge
import {
  DESKTOP_PUSHES_API_KEY,
  type DesktopPushesApi,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
} from '@desktop/shared/hostBridgeChannels';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.ts';

async function loadPreloadModule(electron: {
  contextBridge: { exposeInMainWorld(name: string, api: unknown): void };
  ipcRenderer: {
    on(channel: string, listener: (...args: unknown[]) => void): void;
    off(channel: string, listener: (...args: unknown[]) => void): void;
    send(channel: string, message: unknown): void;
  };
}): Promise<void> {
  vi.resetModules();
  vi.doMock('electron', () => electron);
  await import(moduleFileUrl(desktopSourcePath('preload', 'index.ts')));
}

describe('desktop Electron host bridge', () => {
  // Main connects a window before its page has evaluated: a push posted then
  // (a replayed edit preview) reached no listener while main counted it
  // delivered. The preload holds pushes until the shell says it listens.
  it('holds webview pushes until the shell listens, then posts them in order', async () => {
    const exposed = new Map<string, unknown>();
    const contextBridge = {
      exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api),
    };
    const ipcRenderer = { on: vi.fn(), off: vi.fn(), send: vi.fn() };
    const posted: unknown[] = [];
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('postMessage', (message: unknown) => posted.push(message));

    await loadPreloadModule({ contextBridge, ipcRenderer });
    const push = ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === ELECTRON_WEBVIEW_PUSH_CHANNEL,
    )?.[1] as (event: unknown, message: unknown) => void;

    push({}, { command: 'desktop:showDiff', n: 1 });
    push({}, { command: 'desktop:showPrompt', n: 2 });
    expect(posted).toEqual([]);

    (exposed.get(DESKTOP_PUSHES_API_KEY) as DesktopPushesApi).listening();
    push({}, { command: 'desktop:closeDiff', n: 3 });
    expect(posted.map((message) => (message as { n: number }).n)).toEqual([
      1, 2, 3,
    ]);
  });
});
