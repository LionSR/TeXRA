import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

test('desktop main bundle completes its locked startup write', async () => {
  const { workspacePath, userDataPath } = createIsolatedProfile();
  let launched: LaunchedApp | undefined;

  try {
    launched = await launchTexraApp({ workspacePath, userDataPath });
    // Source of truth: initializeElectronPlatform() opens this store in
    // packages/desktop/src/main/platform/index.ts.
    const globalStatePath = join(userDataPath, 'state', 'global.json');
    const globalState = JSON.parse(
      readFileSync(globalStatePath, 'utf8'),
    ) as Record<string, unknown>;

    expect(globalState.lastKnownVersion).toEqual(expect.any(String));
  } finally {
    if (launched) await closeTexraApp(launched);
    cleanupDirectory(workspacePath);
    cleanupDirectory(userDataPath);
  }
});
