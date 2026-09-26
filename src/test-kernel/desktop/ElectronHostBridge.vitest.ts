// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - shared host bridge
import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
} from '@desktop/shared/hostBridgeChannels';
import { createModuleMocks } from '@test/support/moduleMocks';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.ts';

const mocks = createModuleMocks();

interface MainHostBridgeModule {
  installDesktopHostBridge(
    window: {
      isDestroyed(): boolean;
      once(event: 'closed', listener: () => void): void;
      webContents: {
        isDestroyed(): boolean;
        send(channel: string, message: unknown): void;
      };
    },
    options?: {
      onRendererMessage?(message: unknown, window: unknown): void;
    },
  ): {
    postToRenderer(message: unknown): void;
    dispose(): void;
  };
}

async function loadPreloadModule(electron: {
  contextBridge: { exposeInMainWorld(name: string, api: unknown): void };
  ipcRenderer: {
    on(channel: string, listener: (...args: unknown[]) => void): void;
    off(channel: string, listener: (...args: unknown[]) => void): void;
    send(channel: string, message: unknown): void;
  };
}): Promise<void> {
  vi.resetModules();
  mocks.doMock('electron', () => electron);
  await import(moduleFileUrl(desktopSourcePath('preload', 'index.ts')));
}

async function loadMainHostBridgeModule(ipcMain: {
  on(
    channel: string,
    listener: (event: { sender: unknown }, message: unknown) => void,
  ): void;
  off(
    channel: string,
    listener: (event: { sender: unknown }, message: unknown) => void,
  ): void;
}): Promise<MainHostBridgeModule> {
  vi.resetModules();
  mocks.doMock('electron', () => ({ ipcMain }));
  return import(
    moduleFileUrl(desktopSourcePath('main', 'hostBridge.ts'))
  ) as Promise<MainHostBridgeModule>;
}

interface FakeMainWindow {
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): void;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, message: unknown): void;
  };
}

function fakeMainWindow(sends: Array<{ channel: string; message: unknown }>) {
  const closedListeners: Array<() => void> = [];
  const webContents = {
    isDestroyed: () => false,
    send: vi.fn((channel: string, message: unknown) =>
      sends.push({ channel, message }),
    ),
  };
  const window: FakeMainWindow = {
    isDestroyed: () => false,
    once: vi.fn((_event: 'closed', listener: () => void) => {
      closedListeners.push(listener);
    }),
    webContents,
  };
  return { closedListeners, webContents, window };
}

describe('desktop Electron host bridge', () => {
  it('keeps IPC listeners through canceled closes and removes them after unload', async () => {
    const contextBridge = { exposeInMainWorld: vi.fn() };
    const ipcRenderer = { on: vi.fn(), off: vi.fn(), send: vi.fn() };
    const listeners = new Map<string, () => void>();
    vi.stubGlobal(
      'addEventListener',
      vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
      }),
    );

    await loadPreloadModule({ contextBridge, ipcRenderer });

    expect(listeners.has('beforeunload')).toBe(false);
    expect(listeners.has('unload')).toBe(true);
    const hostListener = ipcRenderer.on.mock.calls[0]?.[1];
    expect(hostListener).toEqual(expect.any(Function));

    // A dirty renderer can cancel beforeunload and remain alive. Its host IPC
    // listener must stay connected until Chromium completes the unload.
    expect(ipcRenderer.off).not.toHaveBeenCalled();
    listeners.get('unload')?.();
    expect(ipcRenderer.off).toHaveBeenCalledOnce();
    expect(ipcRenderer.off).toHaveBeenCalledWith(
      ELECTRON_WEBVIEW_PUSH_CHANNEL,
      hostListener,
    );
  });

  it('routes main-process bridge messages over fixed Electron channels', async () => {
    let rendererListener:
      ((event: { sender: unknown }, message: unknown) => void) | undefined;
    const ipcMain = {
      on: vi.fn((channel, listener) => {
        expect(channel).toBe(ELECTRON_WEBVIEW_MESSAGE_CHANNEL);
        rendererListener = listener;
      }),
      off: vi.fn(),
    };
    const { installDesktopHostBridge } =
      await loadMainHostBridgeModule(ipcMain);
    const sends: Array<{ channel: string; message: unknown }> = [];
    const { closedListeners, webContents, window } = fakeMainWindow(sends);
    const rendererMessages: unknown[] = [];
    const bridge = installDesktopHostBridge(window, {
      onRendererMessage: (message) => rendererMessages.push(message),
    });

    expect(rendererListener).toBeDefined();
    rendererListener?.({ sender: {} }, { ignored: true });
    rendererListener?.({ sender: webContents }, { command: 'ready' });
    expect(rendererMessages).toEqual([{ command: 'ready' }]);

    // `theme` must be a real `ProgressSetThemeMessageSchema` value
    // ('dark' | 'light') — `postToRenderer` now runs every message through
    // `assertKnownOutboundMessage` (dev/test only), so an arbitrary
    // placeholder like the renderer-side test's `'vscode-dark'` would throw
    // here instead of exercising the channel-routing behavior under test.
    const hostMessage = { command: 'setTheme', theme: 'dark' };
    bridge.postToRenderer(hostMessage);
    expect(sends).toEqual([
      { channel: ELECTRON_WEBVIEW_PUSH_CHANNEL, message: hostMessage },
    ]);

    bridge.dispose();
    expect(ipcMain.off).toHaveBeenCalledWith(
      ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
      rendererListener,
    );
    closedListeners[0]?.();
    expect(ipcMain.off).toHaveBeenCalledTimes(1);
  });

  // #8123: `postToRenderer` routes every message through the outbound Zod
  // schemas (dev/test only) before `webContents.send`.
  it('throws on a malformed desktop-only command', async () => {
    const { installDesktopHostBridge } = await loadMainHostBridgeModule({
      on: vi.fn(),
      off: vi.fn(),
    });
    const { window } = fakeMainWindow([]);
    const bridge = installDesktopHostBridge(window);
    // `desktop:showPdf` is claimed by `DesktopOutboundMessageSchema`, so a
    // payload missing `pdfPath` fails validation instead of passing through
    // unchecked.
    expect(() =>
      bridge.postToRenderer({ command: 'desktop:showPdf', title: 't' }),
    ).toThrow(/Outbound message failed schema validation/);
  });
});
