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
