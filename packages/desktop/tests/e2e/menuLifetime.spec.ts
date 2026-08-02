import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  closeTexraApp,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';
import { cleanupDirectory } from './workspaceStorageFixture.js';

let launched: LaunchedApp | undefined;
let userDataPath: string | undefined;

test.afterEach(async () => {
  if (launched) await closeTexraApp(launched);
  launched = undefined;
  if (userDataPath) cleanupDirectory(userDataPath);
  userDataPath = undefined;
});

test('application menu releases a closed window and binds once to its replacement', async () => {
  test.skip(
    process.platform !== 'darwin',
    'The application menu outlives the last window only on macOS.',
  );
  userDataPath = mkdtempSync(join(tmpdir(), 'texra-menu-lifetime-'));
  launched = await launchTexraApp({ userDataPath });

  const windowAId = await launched.app.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('Window A was not created');
    const menu = Menu.getApplicationMenu();
    if (!menu) throw new Error('Window A application menu was not installed');
    return window.id;
  });

  await launched.page.close();
  await expect.poll(() => launched?.app.windows().length).toBe(0);

  const windowlessProbe = await launched.app.evaluate(
    ({ BrowserWindow, Menu }, closedWindowId) => {
      const menu = Menu.getApplicationMenu();
      const showLogs = (menu?.items ?? [])
        .flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === 'Show Logs');
      const appMenu = menu?.items.find((item) => item.role === 'appmenu');
      const quit = appMenu?.submenu?.items.find((item) => item.role === 'quit');
      showLogs?.click(showLogs, BrowserWindow.getFocusedWindow() ?? undefined, {
        triggeredByAccelerator: false,
      });
      return {
        closedWindowStillAttached: BrowserWindow.getAllWindows().some(
          (window) => window.id === closedWindowId,
        ),
        processMenuInstalled: menu != null,
        quitCommandInstalled: quit != null,
        windowCommandInstalled: showLogs != null,
      };
    },
    windowAId,
  );
  expect(windowlessProbe).toEqual({
    closedWindowStillAttached: false,
    processMenuInstalled: true,
    quitCommandInstalled: true,
    windowCommandInstalled: false,
  });

  const windowBPromise = launched.app.waitForEvent('window');
  await launched.app.evaluate(({ app }) => {
    app.emit('activate');
  });
  const windowB = await windowBPromise;
  await windowB.waitForSelector('#app', { state: 'attached' });

  await windowB.evaluate(() => {
    document.body.dataset.menuWorkbenchMessageCount = '0';
    window.addEventListener('message', (event) => {
      const message = event.data as { command?: unknown; kind?: unknown };
      if (
        message.command !== 'desktop:openWorkbench' ||
        message.kind !== 'logs'
      ) {
        return;
      }
      const current = Number.parseInt(
        document.body.dataset.menuWorkbenchMessageCount ?? '0',
        10,
      );
      document.body.dataset.menuWorkbenchMessageCount = String(current + 1);
    });
  });

  const replacementProbe = await launched.app.evaluate(
    ({ BrowserWindow, Menu }, closedWindowId) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Window B was not created');
      const menu = Menu.getApplicationMenu();
      const showLogs = (menu?.items ?? [])
        .flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === 'Show Logs');
      if (!showLogs) throw new Error('Window B menu command was not installed');
      showLogs.click(showLogs, window, { triggeredByAccelerator: false });
      return {
        closedWindowReused: window.id === closedWindowId,
        windowBId: window.id,
      };
    },
    windowAId,
  );
  expect(replacementProbe.closedWindowReused).toBe(false);
  expect(replacementProbe.windowBId).not.toBe(windowAId);
  await expect
    .poll(() =>
      windowB.evaluate(
        () => document.body.dataset.menuWorkbenchMessageCount ?? '0',
      ),
    )
    .toBe('1');
});
