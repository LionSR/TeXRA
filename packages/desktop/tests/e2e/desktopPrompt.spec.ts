import { expect, test } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchTexraApp();
  await dismissOnboarding(launched.page);
});

test.afterAll(async () => {
  if (launched) await closeTexraApp(launched);
});

test('opens an accessible prompt after the desktop shell renders', async () => {
  await launched.page.evaluate(() => {
    window.postMessage(
      {
        command: 'desktop:showPrompt',
        requestId: 'e2e-prompt',
        title: 'Set API key',
        prompt: 'Enter OpenAI API key',
        inputType: 'password',
        placeHolder: 'sk-...',
      },
      '*',
    );
  });

  const dialog = launched.page.getByRole('dialog', { name: 'Set API key' });
  await expect(dialog).toBeVisible();
  const input = launched.page.getByLabel('Enter OpenAI API key');
  await expect(input).toHaveAttribute('type', 'password');
  await expect(input).toBeFocused();

  await launched.page.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});
