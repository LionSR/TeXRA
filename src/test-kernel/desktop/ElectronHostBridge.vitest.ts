// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - shared host bridge
import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
  ELECTRON_WEBVIEW_STATE_GET_CHANNEL,
  ELECTRON_WEBVIEW_STATE_SET_CHANNEL,
} from '@desktop/shared/hostBridgeChannels';
import { HOST_BRIDGE_API_KEY } from '@shared/hostBridgeTypes';
import { createModuleMocks } from '@test/support/moduleMocks';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.ts';

const mocks = createModuleMocks();

type IpcListener = (
  event: { sender: unknown; returnValue?: unknown },
  message?: unknown,
) => void;

interface HostBridgeModule {
  installElectronHostBridge(options: {
    exposeInMainWorld(name: string, api: unknown): void;
    getStateFromMain(channel: string): unknown;
    onHostMessage(channel: string, listener: (message: unknown) => void): void;
    postToRenderer(message: unknown): void;
    sendToMain(channel: string, message: unknown): void;
    setStateInMain(channel: string, state: unknown): unknown;
  }): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
  };
}

interface FakeMainWindow {
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): void;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, message: unknown): void;
  };
}

interface MainHostBridgeModule {
  installDesktopHostBridge(
    window: FakeMainWindow,
    options?: {
      onRendererMessage?(message: unknown, window: unknown): void;
      webviewState?: {
        getState(): Record<string, unknown> | undefined;
        setState(state: unknown): void;
      };
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
  on(channel: string, listener: IpcListener): void;
  off(channel: string, listener: IpcListener): void;
}): Promise<MainHostBridgeModule> {
  vi.resetModules();
  mocks.doMock('electron', () => ({ ipcMain }));
  return import(
    moduleFileUrl(desktopSourcePath('main', 'hostBridge.ts'))
  ) as Promise<MainHostBridgeModule>;
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

function createPreloadOptions() {
  let state: unknown;
  return {
    exposeInMainWorld: vi.fn(),
    getStateFromMain: vi.fn(() => ({ ok: true, state })),
    onHostMessage: vi.fn(),
    postToRenderer: vi.fn(),
    sendToMain: vi.fn(),
    setStateInMain: vi.fn((_channel: string, nextState: unknown) => {
      state = nextState;
      return { ok: true };
    }),
  };
}

describe('desktop Electron host bridge', () => {
  it('exposes only the shared synchronous host bridge surface', async () => {
    const { installElectronHostBridge } = await loadHostBridgeModule();
    const exposed: Record<string, unknown> = {};
    const options = createPreloadOptions();
    options.exposeInMainWorld.mockImplementation((name, api) => {
      exposed[name] = api;
    });

    installElectronHostBridge(options);
    const bridge = exposed[HOST_BRIDGE_API_KEY] as {
      postMessage(message: unknown): void;
      getState(): unknown;
      setState(state: unknown): void;
    };

    expect(Object.keys(bridge).sort()).toEqual([
      'getState',
      'postMessage',
      'setState',
    ]);
    expect(bridge.getState()).toBeUndefined();
    const state = { route: 'main' };
    bridge.setState(state);
    expect(bridge.getState()).toBe(state);
    expect(options.setStateInMain).toHaveBeenCalledWith(
      ELECTRON_WEBVIEW_STATE_SET_CHANNEL,
      state,
    );

    const message = { command: 'webview.ready' };
    bridge.postMessage(message);
    expect(options.sendToMain).toHaveBeenCalledWith(
      ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
      message,
    );
  });

  it('reads every state snapshot from the main-process authority', async () => {
    const { installElectronHostBridge } = await loadHostBridgeModule();
    const options = createPreloadOptions();
    options.getStateFromMain
      .mockReturnValueOnce({ ok: true, state: { draft: 'first' } })
      .mockReturnValueOnce({ ok: true, state: { draft: 'recreated' } });
    const bridge = installElectronHostBridge(options);

    expect(bridge.getState()).toEqual({ draft: 'first' });
    expect(bridge.getState()).toEqual({ draft: 'recreated' });
    expect(options.getStateFromMain).toHaveBeenCalledWith(
      ELECTRON_WEBVIEW_STATE_GET_CHANNEL,
    );
  });

  it('reports a rejected replacement without keeping a preload copy', async () => {
    const { installElectronHostBridge } = await loadHostBridgeModule();
    const options = createPreloadOptions();
    options.getStateFromMain.mockReturnValue({
      ok: true,
      state: { draft: 'known-good' },
    });
    options.setStateInMain.mockReturnValue({ ok: false });
    const bridge = installElectronHostBridge(options);

    expect(() => bridge.setState({ draft: 'new' })).toThrow(
      'Desktop webview state could not be persisted.',
    );
    expect(bridge.getState()).toEqual({ draft: 'known-good' });
  });

  it('installs the bridge on the shared key and forwards host pushes', async () => {
    const { installElectronHostBridge } = await loadHostBridgeModule();
    const exposed: Record<string, unknown> = {};
    const pushes: unknown[] = [];
    let pushListener: ((message: unknown) => void) | undefined;
    const options = createPreloadOptions();
    options.exposeInMainWorld.mockImplementation((name, api) => {
      exposed[name] = api;
    });
    options.onHostMessage.mockImplementation((_channel, listener) => {
      pushListener = listener;
    });
    options.postToRenderer.mockImplementation((message) => {
      pushes.push(message);
    });

    const installed = installElectronHostBridge(options);
    expect(exposed[HOST_BRIDGE_API_KEY]).toBe(installed);
    expect(options.onHostMessage).toHaveBeenCalledWith(
      ELECTRON_WEBVIEW_PUSH_CHANNEL,
      expect.any(Function),
    );
    const message = { command: 'setTheme', theme: 'vscode-dark' };
    pushListener?.(message);
    expect(pushes).toEqual([message]);
  });

  it('routes messages and synchronous state through fixed Electron channels', async () => {
    const listeners = new Map<string, IpcListener>();
    const ipcMain = {
      on: vi.fn((channel: string, listener: IpcListener) => {
        listeners.set(channel, listener);
      }),
      off: vi.fn((channel: string) => {
        listeners.delete(channel);
      }),
    };
    const { installDesktopHostBridge } =
      await loadMainHostBridgeModule(ipcMain);
    const sends: Array<{ channel: string; message: unknown }> = [];
    const { closedListeners, webContents, window } = fakeMainWindow(sends);
    const rendererMessages: unknown[] = [];
    let state: Record<string, unknown> | undefined = { draft: 'stored' };
    const bridge = installDesktopHostBridge(window, {
      onRendererMessage: (message) => rendererMessages.push(message),
      webviewState: {
        getState: () => state,
        setState: (nextState) => {
          state = nextState as Record<string, unknown>;
        },
      },
    });

    listeners.get(ELECTRON_WEBVIEW_MESSAGE_CHANNEL)?.(
      { sender: {} },
      { ignored: true },
    );
    listeners.get(ELECTRON_WEBVIEW_MESSAGE_CHANNEL)?.(
      { sender: webContents },
      { command: 'ready' },
    );
    expect(rendererMessages).toEqual([{ command: 'ready' }]);

    const getEvent = { sender: webContents, returnValue: undefined as unknown };
    listeners.get(ELECTRON_WEBVIEW_STATE_GET_CHANNEL)?.(getEvent);
    expect(getEvent.returnValue).toEqual({
      ok: true,
      state: { draft: 'stored' },
    });
    const setEvent = { sender: webContents, returnValue: undefined as unknown };
    listeners.get(ELECTRON_WEBVIEW_STATE_SET_CHANNEL)?.(setEvent, {
      draft: 'next',
    });
    expect(setEvent.returnValue).toEqual({ ok: true });
    expect(state).toEqual({ draft: 'next' });

    const hostMessage = { command: 'setTheme', theme: 'dark' };
    bridge.postToRenderer(hostMessage);
    expect(sends).toEqual([
      { channel: ELECTRON_WEBVIEW_PUSH_CHANNEL, message: hostMessage },
    ]);
    bridge.dispose();
    expect(ipcMain.off).toHaveBeenCalledTimes(3);
    closedListeners[0]?.();
    expect(ipcMain.off).toHaveBeenCalledTimes(3);
  });

  describe('outbound schema validation (#8123)', () => {
    async function createBridge() {
      const ipcMain = { on: vi.fn(), off: vi.fn() };
      const { installDesktopHostBridge } =
        await loadMainHostBridgeModule(ipcMain);
      const sends: Array<{ channel: string; message: unknown }> = [];
      const { window } = fakeMainWindow(sends);
      return { bridge: installDesktopHostBridge(window), sends };
    }

    it('throws on a ProgressView-domain message with a bad field', async () => {
      const { bridge } = await createBridge();
      expect(() =>
        bridge.postToRenderer({ command: 'setTheme', theme: 'vscode-dark' }),
      ).toThrow(/Outbound message failed schema validation/);
    });

    it('forwards a well-formed MainView outbound message unchanged', async () => {
      const { bridge, sends } = await createBridge();
      const message = {
        command: 'setCurrentFile',
        filePath: 'paper.tex',
        fileType: 'input',
      };
      expect(() => bridge.postToRenderer(message)).not.toThrow();
      expect(sends).toEqual([
        { channel: ELECTRON_WEBVIEW_PUSH_CHANNEL, message },
      ]);
    });

    it('passes desktop-only commands through unchecked', async () => {
      const { bridge, sends } = await createBridge();
      const message = { command: 'desktop:showPdf', title: 't' };
      expect(() => bridge.postToRenderer(message)).not.toThrow();
      expect(sends).toEqual([
        { channel: ELECTRON_WEBVIEW_PUSH_CHANNEL, message },
      ]);
    });
  });
});
