import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createModuleMocks } from '@test/support/moduleMocks';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.ts';

const mocks = createModuleMocks();

class FakeWebContents extends EventEmitter {
  readonly session = {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  };
  title = '';
  loadURL = vi.fn(async () => {});

  getTitle(): string {
    return this.title;
  }

  isDestroyed(): boolean {
    return false;
  }

  setWindowOpenHandler = vi.fn();
}

async function createBrowserViewsHarness() {
  const webContents = new FakeWebContents();
  const view = { webContents, setBounds: vi.fn() };
  class WebContentsView {
    constructor() {
      return view;
    }
  }
  mocks.doMock('electron', () => ({ WebContentsView }));
  const { createDesktopBrowserViews } = await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopBrowserViews.ts'))
  );
  const onNavigated = vi.fn();
  const browserViews = createDesktopBrowserViews({
    getWindow: () => undefined,
    onNavigated,
    openExternalUrl: vi.fn(async () => {}),
    onBlockedExternalUrl: vi.fn(),
    onExternalOpenError: vi.fn(),
  });
  return { browserViews, onNavigated, webContents };
}

describe('desktop browser views', () => {
  it('republishes the current title for full and in-page navigation', async () => {
    const { browserViews, onNavigated, webContents } =
      await createBrowserViewsHarness();

    browserViews.open('browser-a', 'https://example.test/');
    webContents.title = 'Full navigation title';
    webContents.emit('did-navigate');
    webContents.title = 'In-page navigation title';
    webContents.emit('did-navigate-in-page');

    expect(onNavigated).toHaveBeenNthCalledWith(1, {
      tabId: 'browser-a',
      title: 'Full navigation title',
    });
    expect(onNavigated).toHaveBeenNthCalledWith(2, {
      tabId: 'browser-a',
      title: 'In-page navigation title',
    });
  });
});
