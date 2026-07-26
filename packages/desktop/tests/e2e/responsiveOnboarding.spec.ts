import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  closeTexraApp,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

let launched: LaunchedApp;
let userDataPath = '';

test.beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'texra-onboarding-profile-'));
  launched = await launchTexraApp({ userDataPath });
});

test.afterAll(async () => {
  if (launched) await closeTexraApp(launched);
  if (userDataPath) {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('keeps onboarding readable inside a narrow conversation split', async () => {
  const { app, page } = launched;

  await page.waitForFunction(() => {
    const panel = document.querySelector('.desktop-startup-panel');
    return Array.from(panel?.querySelectorAll('wa-button') ?? []).some(
      (button) => button.textContent?.trim() === 'Skip for now',
    );
  });
  await page.evaluate(() => {
    const panel = document.querySelector('.desktop-startup-panel');
    const skip = Array.from(panel?.querySelectorAll('wa-button') ?? []).find(
      (button) => button.textContent?.trim() === 'Skip for now',
    );
    if (skip instanceof HTMLElement) skip.click();
  });
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
