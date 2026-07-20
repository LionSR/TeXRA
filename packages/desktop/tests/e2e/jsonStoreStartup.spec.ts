import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  closeTexraApp,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

test('desktop main bundle completes its locked startup write', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'texra-e2e-workspace-'));
  const userDataPath = mkdtempSync(join(tmpdir(), 'texra-e2e-user-data-'));
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
    for (const path of [workspacePath, userDataPath]) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup must not hide the startup assertion failure.
      }
    }
  }
});
