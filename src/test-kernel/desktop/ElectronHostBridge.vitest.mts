// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - shared host bridge
import { HOST_BRIDGE_API_KEY } from '@shared/hostBridgeTypes';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface HostBridgeModule {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL: string;
  ELECTRON_WEBVIEW_PUSH_CHANNEL: string;
  createElectronHostBridge(
    sendToMain: (channel: string, message: unknown) => void,
  ): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
  };
  installElectronHostBridge(options: {
    exposeInMainWorld(name: string, api: unknown): void;
    onHostMessage(channel: string, listener: (message: unknown) => void): void;
    postToRenderer(message: unknown): void;
    sendToMain(channel: string, message: unknown): void;
  }): unknown;
}

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

async function loadHostBridgeModule(): Promise<HostBridgeModule> {
  return import(
    moduleFileUrl(desktopSourcePath('preload', 'hostBridge.ts'))
  ) as Promise<HostBridgeModule>;
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
  vi.doMock('electron', () => ({ ipcMain }));
  return import(
    moduleFileUrl(desktopSourcePath('main', 'hostBridge.ts'))
  ) as Promise<MainHostBridgeModule>;
}

describe('desktop Electron host bridge', () => {
  afterEach(() => {
    vi.doUnmock('electron');
  });

  it('exposes only the shared synchronous host bridge surface', async () => {
    const { ELECTRON_WEBVIEW_MESSAGE_CHANNEL, createElectronHostBridge } =
      await loadHostBridgeModule();
    const sends: Array<{ channel: string; message: unknown }> = [];
    const bridge = createElectronHostBridge((channel, message) => {
      sends.push({ channel, message });
    });

    expect(Object.keys(bridge).sort()).toEqual([
      'getState',
      'postMessage',
      'setState',
    ]);
    expect(bridge.getState()).toBeUndefined();

    const state = { route: 'main' };
    bridge.setState(state);
    expect(bridge.getState()).toBe(state);

    const message = { command: 'webview.ready' };
    bridge.postMessage(message);
    expect(sends).toEqual([
      { channel: ELECTRON_WEBVIEW_MESSAGE_CHANNEL, message },
    ]);
  });

  it('installs the bridge on the shared key and forwards host pushes', async () => {
    const { ELECTRON_WEBVIEW_PUSH_CHANNEL, installElectronHostBridge } =
      await loadHostBridgeModule();
    const exposed: Record<string, unknown> = {};
    const pushes: unknown[] = [];
    let pushListener: ((message: unknown) => void) | undefined;

    const installed = installElectronHostBridge({
      exposeInMainWorld: (name, api) => {
        exposed[name] = api;
      },
      onHostMessage: (channel, listener) => {
        expect(channel).toBe(ELECTRON_WEBVIEW_PUSH_CHANNEL);
        pushListener = listener;
      },
      postToRenderer: (message) => {
        pushes.push(message);
      },
      sendToMain: () => undefined,
    });

    expect(exposed[HOST_BRIDGE_API_KEY]).toBe(installed);
    expect(pushListener).toBeDefined();

    const message = { command: 'setTheme', theme: 'vscode-dark' };
    pushListener?.(message);
    expect(pushes).toEqual([message]);
  });

  it('routes main-process bridge messages over fixed Electron channels', async () => {
    const { ELECTRON_WEBVIEW_MESSAGE_CHANNEL, ELECTRON_WEBVIEW_PUSH_CHANNEL } =
      await loadHostBridgeModule();
    let rendererListener:
      | ((event: { sender: unknown }, message: unknown) => void)
      | undefined;
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
    const webContents = {
      isDestroyed: () => false,
      send: vi.fn((channel, message) => sends.push({ channel, message })),
    };
    const closedListeners: Array<() => void> = [];
    const window = {
      isDestroyed: () => false,
      once: vi.fn((_event: 'closed', listener: () => void) => {
        closedListeners.push(listener);
      }),
      webContents,
    };
    const rendererMessages: unknown[] = [];
    const bridge = installDesktopHostBridge(window, {
      onRendererMessage: (message) => rendererMessages.push(message),
    });

    expect(rendererListener).toBeDefined();
    rendererListener?.({ sender: {} }, { ignored: true });
    rendererListener?.({ sender: webContents }, { command: 'ready' });
    expect(rendererMessages).toEqual([{ command: 'ready' }]);

    const hostMessage = { command: 'setTheme', theme: 'vscode-dark' };
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
});
