import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  closeTexraApp,
  dismissStartupPanel,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';
import { cleanupDirectory } from './workspaceStorageFixture.js';

let launched: LaunchedApp;
let userDataPath = '';

// The welcome card only renders while the onboarding funnel is in its
// no-credential state. The app treats provider keys exported in the dev
// shell as usable credentials (lookupApiKey reads the environment), and the
// e2e harness inherits them, so scrub every provider key var for this spec.
// Names mirror apiKeyEnvName() over API_KEY_PROVIDER_IDS
// (src/model/apiProviders.ts).
const PROVIDER_KEY_ENV_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_CODE_API_KEY',
  'DASHSCOPE_API_KEY',
  'MINIMAX_API_KEY',
  'GLM_API_KEY',
  'META_API_KEY',
] as const;

test.beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'texra-onboarding-profile-'));
  launched = await launchTexraApp({
    userDataPath,
    env: Object.fromEntries(PROVIDER_KEY_ENV_NAMES.map((name) => [name, ''])),
  });
});

test.afterAll(async () => {
  if (launched) await closeTexraApp(launched);
  if (userDataPath) cleanupDirectory(userDataPath);
});

test('keeps onboarding readable inside a narrow conversation split', async () => {
  const { app, page } = launched;

  await dismissStartupPanel(page, { required: true });
  await page.waitForFunction(
    () =>
      document
        .querySelector('main-app')
        ?.shadowRoot?.querySelector('onboarding-welcome-card') != null,
  );

  await page
    .locator('.task-sidebar-footer .task-sidebar-action')
    .filter({ hasText: 'Settings' })
    .click();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().at(0)?.setContentSize(1000, 760);
  });

  const metrics = await page.evaluate(() => {
    const mainRoot = document.querySelector('main-app')?.shadowRoot;
    const onboarding = mainRoot?.querySelector<HTMLElement>(
      'onboarding-welcome-card',
    );
    const root = onboarding?.shadowRoot;
    const container = root?.querySelector<HTMLElement>(
      '.welcome-card-container',
    );
    const steps = [
      ...(root?.querySelectorAll<HTMLElement>('.path-step') ?? []),
    ];
    const buttons = [
      ...(root?.querySelectorAll<HTMLElement>('.choice wa-button') ?? []),
    ];
    if (!container || steps.length !== 3 || buttons.length !== 3) {
      throw new Error('Responsive onboarding controls were not mounted.');
    }
    const containerRect = container.getBoundingClientRect();
    return {
      containerWidth: containerRect.width,
      overflow: container.scrollWidth - container.clientWidth,
      stepRows: new Set(steps.map((step) => Math.round(step.offsetTop))).size,
      buttonOverflow: buttons.map((button) => {
        const base =
          button.shadowRoot?.querySelector<HTMLElement>('[part~="base"]');
        return base
          ? base.scrollWidth - base.clientWidth
          : Number.POSITIVE_INFINITY;
      }),
    };
  });

  expect(metrics.containerWidth).toBeLessThan(420);
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  expect(metrics.stepRows).toBe(3);
  expect(metrics.buttonOverflow.every((overflow) => overflow <= 1)).toBe(true);
});
