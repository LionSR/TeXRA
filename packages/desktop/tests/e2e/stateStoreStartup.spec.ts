import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { closeTexraApp, expect, test } from './electronApp.js';

test('desktop main bundle completes its startup state write', async ({
  launched,
}) => {
  // Source of truth: initializeElectronPlatform() opens this profile's
  // state store in packages/desktop/src/main/platform/index.ts and seeds
  // the first-install defaults through it before the window exists.
  const databasePath = join(
    launched.profile.dataRoot,
    'v1',
    'global-storage',
    'texra.db',
  );
  expect(existsSync(databasePath)).toBe(true);
  const database = new DatabaseSync(databasePath);
  try {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS written FROM current_value WHERE family = 'app-state'",
      )
      .get() as { written: number } | undefined;
    expect(Number(row?.written ?? 0)).toBeGreaterThan(0);
  } finally {
    database.close();
  }
});

test('desktop renderer boots past unreadable saved renderer state', async ({
  launch,
}) => {
  // Two cold launches of one profile: each alone can take most of the
  // default budget.
  test.setTimeout(150_000);
  // Seed the renderer's own `localStorage` through a first launch of the
  // same profile: the shell's collapsed-rail key is read at module load.
  const first = await launch();
  await first.page.evaluate(() => {
    window.localStorage.setItem('shell', '{not json');
  });
  await closeTexraApp(first);

  // `launchTexraApp` waits for the renderer's ready marker and a visible
  // window, so a blank window fails the relaunch itself.
  const { page } = await launch();
  await expect(page.locator('.shell-frame')).toBeVisible();
  // The artifact: the booted window over the corrupt entry.
  await page.screenshot({
    path: test.info().outputPath('corrupt-renderer-state.png'),
  });
});
