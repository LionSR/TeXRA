import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

import {
  closeTexraApp,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';
import {
  cleanupDirectory,
  createIsolatedProfile,
} from './workspaceStorageFixture.js';

test('desktop main bundle completes its startup state write', async () => {
  const { workspacePath, userDataPath } = createIsolatedProfile();
  let launched: LaunchedApp | undefined;

  try {
    launched = await launchTexraApp({ workspacePath, userDataPath });
    // Source of truth: initializeElectronPlatform() opens this profile's
    // state store in packages/desktop/src/main/platform/index.ts and seeds
    // the first-install defaults through it before the window exists.
    const databasePath = join(userDataPath, 'v1', 'global-storage', 'texra.db');
    expect(existsSync(databasePath)).toBe(true);
    const database = new DatabaseSync(databasePath);
    try {
      const row = database
        .prepare(
          "SELECT COUNT(*) AS written FROM event WHERE type = 'state.value.set.1'" +
            " AND json_extract(data, '$.state.key') = 'app-state'",
        )
        .get() as { written: number } | undefined;
      expect(Number(row?.written ?? 0)).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  } finally {
    if (launched) await closeTexraApp(launched);
    cleanupDirectory(workspacePath);
    cleanupDirectory(userDataPath);
  }
});

test('desktop renderer boots past unreadable saved renderer state', async () => {
  // Two cold launches of one profile: each alone can take most of the
  // default budget.
  test.setTimeout(150_000);
  const { workspacePath, userDataPath } = createIsolatedProfile();
  let launched: LaunchedApp | undefined;

  try {
    // Seed the renderer's own `localStorage` through a first launch of the
    // same profile: the shell's collapsed-rail key is read at module load.
    launched = await launchTexraApp({ workspacePath, userDataPath });
    await launched.page.evaluate(() => {
      window.localStorage.setItem('shell', '{not json');
    });
    await closeTexraApp(launched);
    launched = undefined;

    // `launchTexraApp` waits for the renderer's ready marker and a visible
    // window, so a blank window fails the relaunch itself.
    launched = await launchTexraApp({ workspacePath, userDataPath });
    await expect(launched.page.locator('.shell-frame')).toBeVisible();
    // The artifact: the booted window over the corrupt entry.
    await launched.page.screenshot({
      path: test.info().outputPath('corrupt-renderer-state.png'),
    });
  } finally {
    if (launched) await closeTexraApp(launched);
    cleanupDirectory(workspacePath);
    cleanupDirectory(userDataPath);
  }
});
