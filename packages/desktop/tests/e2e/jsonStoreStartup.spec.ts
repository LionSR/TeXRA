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
    const globalState = JSON.parse(
      readFileSync(join(userDataPath, 'state', 'global.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(globalState.lastKnownVersion).toEqual(expect.any(String));
  } finally {
    if (launched) await closeTexraApp(launched);
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
