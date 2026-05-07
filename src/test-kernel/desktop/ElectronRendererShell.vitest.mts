// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.mjs';

function readRendererMain(): string {
  return readFileSync(
    repoPath('packages/desktop/src/renderer/main.ts'),
    'utf8',
  );
}

function readRendererOnboarding(): string {
  return readFileSync(
    repoPath('packages/desktop/src/renderer/desktopOnboarding.ts'),
    'utf8',
  );
}

describe('desktop renderer shell', () => {
  it('mounts the reused launcher, progress, and settings Lit apps', () => {
    const rendererMain = readRendererMain();

    expect(rendererMain).toContain("import '@webview/frontend'");
    expect(rendererMain).toContain("import '@progressView/frontend'");
    expect(rendererMain).toContain("import '@settingsView/frontend'");
    expect(rendererMain).toContain("document.createElement('main-app')");
    expect(rendererMain).toContain("document.createElement('progress-app')");
    expect(rendererMain).toContain("document.createElement('settings-app')");
  });

  it('listens for desktop route pushes from the Electron host', () => {
    const rendererMain = readRendererMain();

    expect(rendererMain).toContain('DesktopSetRouteMessageSchema.safeParse');
    expect(rendererMain).toContain('window.addEventListener');
    expect(rendererMain).toContain('document.body.dataset.desktopRoute');
  });

  it('provides persistent shell controls for returning between routes', () => {
    const rendererMain = readRendererMain();

    expect(rendererMain).toContain("{ route: 'main', label: 'Launcher' }");
    expect(rendererMain).toContain("{ route: 'progress', label: 'Progress' }");
    expect(rendererMain).toContain("{ route: 'settings', label: 'Settings' }");
    expect(rendererMain).toContain("{ route: 'logs', label: 'Logs' }");
    expect(rendererMain).toContain('data-route-button=${route}');
    expect(rendererMain).toContain("button.addEventListener('click'");
    expect(rendererMain).toContain("button.setAttribute('aria-pressed'");
  });

  it('mounts a persistent workspace explorer sidebar', () => {
    const rendererMain = readRendererMain();

    expect(rendererMain).toContain('id="desktop-explorer"');
    expect(rendererMain).toContain('REQUEST_TREE');
    expect(rendererMain).toContain('OPEN_FILE');
    expect(rendererMain).toContain('SELECT_FILE');
    expect(rendererMain).toContain('Use as ${typedCategory}');
  });

  it('mounts the catalog-backed command palette', () => {
    const rendererMain = readRendererMain();

    expect(rendererMain).toContain('createDesktopCommandPalette');
    expect(rendererMain).toContain('data-command-palette-button');
    expect(rendererMain).toContain('buildDesktopSettingsTabMessage');
    expect(rendererMain).toContain('showSettings: (tabIndex, agentSubTab)');
  });

  it('mounts desktop-only first-run onboarding controls', () => {
    const rendererMain = readRendererMain();
    const rendererOnboarding = readRendererOnboarding();

    expect(rendererMain).toContain('createFirstRunWalkthrough');
    expect(rendererMain).toContain('DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE');
    expect(rendererMain).toContain('DESKTOP_ONBOARDING_COMMANDS.DISMISS');
    expect(rendererMain).toContain('showFirstRunWalkthrough');
    expect(rendererMain).toContain(
      'canOpen: () => !firstRunWalkthrough.isVisible()',
    );
    // wa-dialog handles focus trap, escape, and modal backdrop natively.
    // Assert the dialog wiring + the one custom keydown interceptor.
    expect(rendererOnboarding).toContain("document.createElement('wa-dialog')");
    expect(rendererOnboarding).toContain(
      "dialog.addEventListener('wa-after-show'",
    );
    expect(rendererOnboarding).toContain(
      "dialog.addEventListener('wa-after-hide'",
    );
    expect(rendererOnboarding).toContain("dialog.addEventListener('keydown'");
    expect(rendererOnboarding).toContain('isCommandPaletteShortcut(event)');
  });

  it('mounts an in-app log viewer with copy and export actions', () => {
    const rendererMain = readRendererMain();

    expect(rendererMain).toContain('DESKTOP_LOG_COMMANDS.REQUEST_LOG');
    expect(rendererMain).toContain('DESKTOP_LOG_COMMANDS.COPY_LOG');
    expect(rendererMain).toContain('DESKTOP_LOG_COMMANDS.EXPORT_LOG');
    expect(rendererMain).toContain('DesktopSetLogMessageSchema.safeParse');
    expect(rendererMain).toContain('logViewerTemplate');
  });
});
