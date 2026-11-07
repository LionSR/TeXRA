import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
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
  // The renderer goes before the main process's `closed` handler swaps in
  // the window-less menu, so wait for the main process's own view of the
  // release rather than the page count alone.
  await expect
    .poll(() =>
      launched?.app.evaluate(({ BrowserWindow, Menu }) => {
        const items = (Menu.getApplicationMenu()?.items ?? []).flatMap(
          (item) => item.submenu?.items ?? [],
        );
        return (
          BrowserWindow.getAllWindows().length === 0 &&
          !items.some((item) => item.label === 'Show Logs')
        );
      }),
    )
    .toBe(true);

  const windowlessProbe = await launched.app.evaluate(
    ({ BrowserWindow, Menu }, closedWindowId) => {
      const menu = Menu.getApplicationMenu();
      const menuItems = (menu?.items ?? []).flatMap(
        (item) => item.submenu?.items ?? [],
      );
      const showLogs = menuItems.find((item) => item.label === 'Show Logs');
      const quit = menuItems.find((item) => item.role === 'quit');
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

test('a closed project is offered in the empty rail and reopens from it', async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'texra-recent-projects-'));
  launched = await launchTexraApp({ userDataPath });
  const { page, app, workspaceRoot } = launched;
  await dismissOnboarding(page);
  const name = basename(workspaceRoot);
  // The app stores the folder canonicalized (macOS: /tmp is /private/tmp).
  const root = realpathSync(workspaceRoot);
  const rail = page.getByRole('region', { name: 'Open projects' });

  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Close project' }).click();
  const reopen = rail.getByRole('button', { name, exact: true });
  await expect(reopen).toBeVisible();
  await expect(reopen).toHaveAttribute('title', `Reopen ${root}`);
  // The rail offers what File > Open Recent holds.
  const menuRecent = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      ?.items.find((item) => item.label === 'File')
      ?.submenu?.items.find((item) => item.label === 'Open Recent')
      ?.submenu?.items.map((item) => item.label),
  );
  expect(menuRecent).toContain(root);
  await page.screenshot({
    path: test.info().outputPath('empty-rail-recent.png'),
  });

  await reopen.click();
  await expect(
    rail.getByRole('button', { name: `Actions for ${name}` }),
  ).toBeVisible();
  // An open project is not offered again (the rail offers recent ones only
  // while no project is open).
  await expect(rail.locator('[title^="Reopen "]')).toHaveCount(0);
});
