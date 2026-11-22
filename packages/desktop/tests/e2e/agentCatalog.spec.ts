import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDatabaseFixture } from '../../../../scripts/desktop-package-smoke-environment.mjs';
import {
  dismissOnboarding,
  expect,
  setSettingsTab,
  showLauncher,
  test,
} from './electronApp.js';

// Real catalog and IPC, isolated profile, no model calls or external editors.
test('browses agents and opens read-only and editable YAML inside the workbench', async ({
  profile,
  launch,
}) => {
  const fixture = await loadDatabaseFixture();
  const customDir = join(
    fixture.resolveGlobalStoragePath(profile.dataRoot),
    'custom_agents',
  );
  mkdirSync(customDir, { recursive: true });
  const customPath = join(customDir, 'catalog-fixture.yaml');
  writeFileSync(
    customPath,
    'name: catalog-fixture\ndescription: Inspect catalog editor behavior\ntools: [read_file]\nprompt: Help inspect the catalog.\n',
  );
  const launched = await launch();
  const { page, app } = launched;
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
  await catalog.getByRole('button', { name: 'Open YAML', exact: true }).click();
  const settings = page.locator('wa-dialog.desktop-settings-overlay');
  await expect(settings).toHaveJSProperty('open', false);
  const editor = page.locator('.shell-dock-editor:visible');
  await expect(editor.locator('.view-lines')).toContainText('catalog-fixture');
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
  await catalog.locator('.catalog-row-select[aria-label="assistant"]').click();
  await catalog.getByRole('button', { name: 'View YAML', exact: true }).click();
  await expect(settings).toHaveJSProperty('open', false);
  await expect(editor.locator('.view-lines')).toContainText('name: assistant');
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
});

// A launch whose run cannot start, for want of a key for the form's model,
// is told once: by the window's notice, not again by the form, which keeps
// the instruction to send once a key is set.
test('a launch that cannot start is told once, by its notice', async ({
  launch,
}) => {
  const launched = await launch(
    // The profile holds no key; a key in this environment would start a
    // real run.
    Object.fromEntries(
      Object.keys(process.env)
        .filter((name) => name.endsWith('_API_KEY'))
        .map((name) => [name, '']),
    ),
  );
  const { app, page } = launched;
  // The window's message boxes are recorded and dismissed. The record is
  // this test's handle, not a global of the app.
  const shownMessageBoxes = await app.evaluateHandle(({ dialog }) => {
    const shown: string[] = [];
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; cancelId?: number };
      shown.push(options.message);
      return { response: options.cancelId ?? 0, checkboxChecked: false };
    };
    return shown;
  });
  await dismissOnboarding(page);
  await showLauncher(launched);

  const instruction = 'Summarize this project.';
  await page.locator('#composer-text').fill(instruction);
  await page.locator('#composer-send').click();
  await expect
    .poll(() => shownMessageBoxes.jsonValue())
    .toEqual([
      'Missing API key for openai. Set a provider API key in settings.',
    ]);
  // The launch has its answer once the Send is no longer busy.
  await expect(
    page.locator('session-composer .action-busy-spinner'),
  ).toHaveCount(0);
  await expect(page.locator('progress-app .request-notice')).toHaveCount(0);
  await expect(page.locator('#composer-text')).toHaveValue(instruction);
  const shown = await shownMessageBoxes.jsonValue();
  expect(shown).toHaveLength(1);
  writeFileSync(
    test.info().outputPath('message-boxes.json'),
    `${JSON.stringify(shown, null, 2)}\n`,
  );
  await page.screenshot({
    path: test.info().outputPath('launch-told-once.png'),
  });
});
