import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDatabaseFixture } from '../../../../scripts/desktop-package-smoke-environment.mjs';
import {
  mark,
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
  test.setTimeout(180_000);
  mark('t13 start');
  const fixture = await loadDatabaseFixture();
  mark('t13 step 1: const fixture = await loadDatabaseFixture();');
  const customDir = join(
    fixture.resolveGlobalStoragePath(profile.dataRoot),
    'custom_agents',
  );
  mark('t13 step 2: );');
  mkdirSync(customDir, { recursive: true });
  mark('t13 step 3: mkdirSync(customDir, { recursive: true });');
  const customPath = join(customDir, 'catalog-fixture.yaml');
  mark('t13 step 4: const customPath = join(customDir, catalog-fixture.yaml);');
  writeFileSync(
    customPath,
    'name: catalog-fixture\ndescription: Inspect catalog editor behavior\ntools: [read_file]\nprompt: Help inspect the catalog.\n',
  );
  mark('t13 step 5: );');
  const launched = await launch();
  mark('t13 step 6: const launched = await launch();');
  const { page, app } = launched;
  mark('t13 step 7: const { page, app } = launched;');
  await setSettingsTab(launched, 'agents');
  mark('t13 step 8: await setSettingsTab(launched, agents);');
  const catalog = page.locator('agent-selection-panel');
  mark('t13 step 9: const catalog = page.locator(agent-selection-panel);');
  const search = catalog.getByRole('textbox', {
    name: 'Search agents',
    exact: true,
  });
  mark('t13 step 10: });');
  await search.fill('catalog-fixture');
  mark('t13 step 11: await search.fill(catalog-fixture);');
  await expect(catalog.locator('.catalog-row')).toHaveCount(1);
  mark('t13 step 12: await expect(catalog.locator(.catalog-row)).toHaveCount(1)');
  await expect(catalog.locator('#catalog-detail-name')).toContainText(
    'catalog-fixture',
  );
  mark('t13 step 13: );');
  await catalog.getByRole('button', { name: 'Open YAML', exact: true }).click();
  mark('t13 step 14: await catalog.getByRole(button, { name: Open YAML, exact');
  const settings = page.locator('wa-dialog.desktop-settings-overlay');
  mark('t13 step 15: const settings = page.locator(wa-dialog.desktop-settings-ov');
  await expect(settings).toHaveJSProperty('open', false);
  mark('t13 step 16: await expect(settings).toHaveJSProperty(open, false);');
  const editor = page.locator('.shell-dock-editor:visible');
  mark('t13 step 17: const editor = page.locator(.shell-dock-editor:visible);');
  await expect(editor.locator('.view-lines')).toContainText('catalog-fixture');
  mark('t13 step 18: await expect(editor.locator(.view-lines)).toContainText(c');
  const mod = await app.evaluate(() =>
    process.platform === 'darwin' ? 'Meta' : 'Control',
  );
  mark('t13 step 19: );');
  await editor.locator('.view-line').first().click();
  mark('t13 step 20: await editor.locator(.view-line).first().click();');
  await page.keyboard.press(`${mod}+End`);
  mark('t13 step 21: await page.keyboard.press(`${mod}+End`);');
  await page.keyboard.type('\n# saved by the internal editor');
  mark('t13 step 22: await page.keyboard.type(\n# saved by the internal editor)');
  await page.keyboard.press(`${mod}+s`);
  mark('t13 step 23: await page.keyboard.press(`${mod}+s`);');
  await expect
    .poll(() => readFileSync(customPath, 'utf8'))
    .toContain('# saved by the internal editor');

  await setSettingsTab(launched, 'agents');
  mark('t13 step 24: await setSettingsTab(launched, agents);');
  await search.fill('assistant');
  mark('t13 step 25: await search.fill(assistant);');
  await catalog.locator('.catalog-row-select[aria-label="assistant"]').click();
  mark('t13 step 26: await catalog.locator(.catalog-row-select[aria-label="assis');
  await catalog.getByRole('button', { name: 'View YAML', exact: true }).click();
  mark('t13 step 27: await catalog.getByRole(button, { name: View YAML, exact');
  await expect(settings).toHaveJSProperty('open', false);
  mark('t13 step 28: await expect(settings).toHaveJSProperty(open, false);');
  await expect(editor.locator('.view-lines')).toContainText('name: assistant');
  mark('t13 step 29: await expect(editor.locator(.view-lines)).toContainText(n');
  await editor.locator('.view-line').first().click();
  mark('t13 step 30: await editor.locator(.view-line).first().click();');
  await page.keyboard.press(`${mod}+Home`);
  mark('t13 step 31: await page.keyboard.press(`${mod}+Home`);');
  await page.keyboard.type('SHOULD_NOT_EDIT');
  mark('t13 step 32: await page.keyboard.type(SHOULD_NOT_EDIT);');
  await expect(editor.locator('.view-lines')).not.toContainText(
    'SHOULD_NOT_EDIT',
  );
  mark('t13 step 33: );');

  // Stable catalog resources reopen after a renderer reload.
  await page.reload();
  mark('t13 step 34: await page.reload();');
  await expect(
    page.locator('.shell-dock-editor:visible .view-lines'),
  ).toContainText('name: assistant');
  mark('t13 step 35: ).toContainText(name: assistant);');
});

// A document agent picked in the composer, then hidden in Settings → Agents
// (#14240). The form and the launch read the one agent list, so the form
// shows no agent and no file section, and both launches it allows, with no
// files and with a pasted image, are refused instead of running the hidden
// agent as a document task.
test('a picked document agent hidden in Settings is no agent to the form or the launch', async ({
  launched,
}) => {
  const { page } = launched;
  await dismissOnboarding(page);
  await showLauncher(launched);
  const agentChip = page.locator('#composer-agent');
  const fileSection = page.locator('progress-app wa-details.context');
  const notice = page.locator('progress-app .request-notice');
  const refusal =
    'Choose an agent first: polish is hidden from the agent selector.';

  await agentChip.click();
  await page
    .locator('session-composer wa-dropdown-item[value="agent:builtIn:polish"]')
    .click();
  await expect(agentChip).toContainText('polish');
  await expect(fileSection).toBeVisible();

  await setSettingsTab(launched, 'agents');
  const catalog = page.locator('agent-selection-panel');
  await catalog
    .getByRole('textbox', { name: 'Search agents', exact: true })
    .fill('polish');
  // The toggle's state is on the host element, not on its inner button.
  const shown = catalog.locator(
    'wa-button[aria-label="Show polish in agent selector"]',
  );
  await expect(shown).toHaveAttribute('aria-pressed', 'true');
  await shown.click();
  await expect(shown).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.desktop-settings-close').click();
  await showLauncher(launched);

  await expect(fileSection).toHaveCount(0);
  await page.locator('#composer-text').fill('Polish the introduction.');
  await page.locator('#composer-send').click();
  await expect(notice).toContainText(refusal);
  await expect(agentChip).toContainText('Choose agent');

  // A pasted image is the composer's own attachment for an agent with no
  // file section; it does not make the hidden agent a document task.
  await page.locator('#dismiss-request-notice').click();
  await expect(notice).toHaveCount(0);
  await page.locator('#composer-text').evaluate((textarea) => {
    // A 1×1 transparent PNG.
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      ),
      (char) => char.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([png], 'figure.png', { type: 'image/png' }));
    textarea.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(
    page.locator('launch-attachments [role="listitem"]'),
  ).toHaveCount(1);
  await page.locator('#composer-send').click();
  await expect(notice).toContainText(refusal);
  await page.screenshot({
    path: test.info().outputPath('hidden-agent-launch-refused.png'),
  });
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
      'The TeXRA service could not start the task: Missing API key for openai. Set a provider API key in settings.',
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
