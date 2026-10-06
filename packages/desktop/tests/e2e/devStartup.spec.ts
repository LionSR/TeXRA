import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { createServer } from 'vite';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';
import { cleanupDirectory } from './workspaceStorageFixture.js';

test('renders the dev app from a cold cache and restores the editor after reload', async () => {
  const testInfo = test.info();
  const temporary = mkdtempSync(join(tmpdir(), 'texra-dev-startup-'));
  writeFileSync(
    join(temporary, 'sample.tex'),
    'A dev editor document.\n' +
      Array.from({ length: 599 }, (_, index) => `% Line ${index + 2}`).join(
        '\n',
      ),
  );
  const server = await createServer({
    configFile: resolve(import.meta.dirname, '../../vite.config.ts'),
    cacheDir: join(temporary, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0 },
  });
  let launched: LaunchedApp | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string')
      throw new Error('The Vite development server did not open a port.');
    launched = await launchTexraApp({
      workspacePath: temporary,
      env: {
        ELECTRON_RENDERER_URL: `http://127.0.0.1:${address.port}`,
        NODE_ENV: 'development',
      },
    });
    const { page } = launched;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await dismissOnboarding(page);
    await expect(page.locator('.shell-sidebar')).toBeVisible();
    await expect(page.locator('session-composer')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('dev-startup.png'),
      animations: 'disabled',
    });

    let navigations = 0;
    page.on('framenavigated', () => {
      navigations += 1;
    });
    await page.locator('#shellToggleSidePanel').click();
    await page
      .locator('.desktop-editor-tree-row[data-path="sample.tex"]')
      .click();
    const editor = page.locator('.desktop-editor-surface .view-lines');
    await expect(editor).toContainText('A dev editor document.');
    expect(navigations, 'Opening the editor must not reload the dev app').toBe(
      0,
    );

    await page.reload();
    await expect(page.locator('.shell-sidebar')).toBeVisible();
    await expect(editor).toContainText('A dev editor document.');
    await page.screenshot({
      path: testInfo.outputPath('dev-reloaded-editor.png'),
      animations: 'disabled',
    });
    for (const theme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('body')).toHaveClass(
        new RegExp(`vscode-${theme}`),
      );
      await expect
        .poll(() =>
          page.evaluate(() => {
            const source = getComputedStyle(
              document.querySelector('.monaco-editor')!,
            );
            return (
              source.backgroundColor ===
                getComputedStyle(document.body).backgroundColor &&
              source.backgroundColor !== source.color
            );
          }),
        )
        .toBe(true);
      await editor.locator('.view-line').first().click();
      await page.keyboard.press('F1');
      const palette = page.locator('.quick-input-widget');
      await expect(palette).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`editor-commands-${theme}.png`),
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
      await editor.locator('.view-line').first().click({ button: 'right' });
      const menu = page.locator(
        '.context-view.monaco-menu-container .monaco-menu',
      );
      await expect(menu).toBeVisible();
      const menuColors = await menu.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        foreground: getComputedStyle(element.querySelector('.action-label')!)
          .color,
      }));
      expect(menuColors.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(menuColors.background).not.toBe(menuColors.foreground);
      await page.screenshot({
        path: testInfo.outputPath(`editor-context-menu-${theme}.png`),
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
    const platform = await launched.app.evaluate(() => process.platform);
    await editor.locator('.view-line').first().click();
    await page.keyboard.press(
      platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
    );
    await expect(editor).toContainText('Line 600');
    await page.screenshot({
      path: testInfo.outputPath('editor-gutter-three-digits.png'),
      animations: 'disabled',
    });
    // The embedded preview uses the same editor styling through a component
    // slot. Its visible frame must size both diff editors, including on resize.
    await page.evaluate(() => {
      const preview = document.createElement(
        'texra-diff-view',
      ) as HTMLElement & {
        originalText: string;
        proposedText: string;
        language: string;
        fill: boolean;
      };
      preview.originalText = 'const result = theorem(input);';
      preview.proposedText = 'const result = theorem(input, assumptions);';
      preview.language = 'typescript';
      preview.fill = true;
      preview.style.cssText =
        'position:fixed;inset:100px 100px auto;height:320px;z-index:3000';
      document.body.append(preview);
    });
    const diff = page.locator('texra-diff-view');
    await expect
      .poll(
        async () =>
          (await diff.locator('.monaco-diff-editor').boundingBox())?.height ??
          0,
      )
      .toBeGreaterThanOrEqual(300);
    await expect(diff.locator('.modified-in-monaco-diff-editor')).toContainText(
      'assumptions',
    );
    for (const theme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await diff.evaluate((preview, value) => {
        (preview as HTMLElement & { hostTheme: string }).hostTheme = value;
      }, theme);
      await page.screenshot({
        path: testInfo.outputPath(`diff-preview-${theme}.png`),
        animations: 'disabled',
      });
    }
    await diff.evaluate((preview) => preview.remove());
    expect(errors, 'Uncaught development renderer errors').toEqual([]);
  } finally {
    try {
      if (launched) await closeTexraApp(launched);
    } finally {
      await server.close();
      cleanupDirectory(temporary);
    }
  }
});
