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
          "SELECT COUNT(*) AS written FROM event WHERE type = 'state.value.set.1'",
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
