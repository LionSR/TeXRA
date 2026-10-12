import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loadDatabaseFixture } from '../../../../scripts/desktop-package-smoke-environment.mjs';
import {
  closeTexraApp,
  launchTexraApp,
  setSettingsTab,
  type LaunchedApp,
} from './electronApp.js';
import {
  cleanupDirectory,
  createIsolatedProfile,
} from './workspaceStorageFixture.js';

// Real catalog and IPC, isolated profile, no model calls or external editors.
test('browses agents and opens read-only and editable YAML inside the workbench', async () => {
  const profile = createIsolatedProfile();
  const fixture = await loadDatabaseFixture(profile.userDataPath);
  const customDir = join(
    fixture.resolveGlobalStoragePath(profile.userDataPath),
    'custom_agents',
  );
  mkdirSync(customDir, { recursive: true });
  const customPath = join(customDir, 'catalog-fixture.yaml');
  writeFileSync(
    customPath,
    'name: catalog-fixture\ndescription: Inspect catalog editor behavior\ntools: [read_file]\nprompt: Help inspect the catalog.\n',
  );
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchTexraApp(profile);
    const { page, app } = launched;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await setSettingsTab(launched, 'agents');
    const catalog = page.locator('agent-selection-panel');
    const search = catalog.getByRole('textbox', {
      name: 'Search agents',
      exact: true,
    });
    await search.fill('catalog-fixture');
    await expect(catalog.locator('.catalog-row')).toHaveCount(1);
    await expect(catalog.locator('#catalog-detail-name')).toContainText(
      'catalog-fixture',
    );
    await catalog
      .getByRole('button', { name: 'Open YAML', exact: true })
      .click();
    const settings = page.locator('wa-dialog.desktop-settings-overlay');
    await expect(settings).toHaveJSProperty('open', false);
    const editor = page.locator('.shell-dock-editor:visible');
    await expect(editor.locator('.view-lines')).toContainText(
      'catalog-fixture',
    );
    const mod = await app.evaluate(() =>
      process.platform === 'darwin' ? 'Meta' : 'Control',
    );
    await editor.locator('.view-line').first().click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type('\n# saved by the internal editor');
    await page.keyboard.press(`${mod}+s`);
    await expect
      .poll(() => readFileSync(customPath, 'utf8'))
      .toContain('# saved by the internal editor');

    await setSettingsTab(launched, 'agents');
    await search.fill('assistant');
    await catalog
      .locator('.catalog-row-select[aria-label="assistant"]')
      .click();
    await catalog
      .getByRole('button', { name: 'View YAML', exact: true })
      .click();
    await expect(settings).toHaveJSProperty('open', false);
    await expect(editor.locator('.view-lines')).toContainText(
      'name: assistant',
    );
    await editor.locator('.view-line').first().click();
    await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.type('SHOULD_NOT_EDIT');
    await expect(editor.locator('.view-lines')).not.toContainText(
      'SHOULD_NOT_EDIT',
    );

    // Stable catalog resources reopen after a renderer reload.
    await page.reload();
    await expect(
      page.locator('.shell-dock-editor:visible .view-lines'),
    ).toContainText('name: assistant');
    expect(errors).toEqual([]);
  } finally {
    if (launched) await closeTexraApp(launched);
    cleanupDirectory(profile.workspacePath);
    cleanupDirectory(profile.userDataPath);
  }
});
