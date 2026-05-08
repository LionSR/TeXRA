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

function readSharedWalkthroughDialog(): string {
  return readFileSync(repoPath('src/shared/wa/walkthroughDialog.ts'), 'utf8');
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

    // The chrome was simplified to show only Settings + Logs as icon
    // buttons; other routes are reachable through the command palette and
    // the "Back to Launcher" affordance. CHROME_ICON_BUTTONS keeps both
    // lists aligned so future contributors update them together.
    expect(rendererMain).toContain('CHROME_ICON_BUTTONS');
    expect(rendererMain).toContain("route: 'settings'");
    expect(rendererMain).toContain("route: 'logs'");
    expect(rendererMain).toContain('data-route-button=${spec.route}');
    expect(rendererMain).toContain('aria-pressed=${String(currentRoute');
    expect(rendererMain).toContain('toggleRoute');
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
    // The chrome exposes a "Commands" button that opens the palette via the
    // module-scoped commandPalette controller. Earlier revisions used a
    // data-command-palette-button hook; the WA migration switched to a
    // direct @click=${openCommandPalette} binding instead.
    expect(rendererMain).toContain('openCommandPalette');
    expect(rendererMain).toContain('buildDesktopSettingsTabMessage');
    expect(rendererMain).toContain('showSettings: (tabIndex, agentSubTab)');
  });

  it('mounts desktop-only first-run onboarding controls', () => {
    const rendererMain = readRendererMain();
    const rendererOnboarding = readRendererOnboarding();
    const sharedWalkthrough = readSharedWalkthroughDialog();

    expect(rendererMain).toContain('createFirstRunWalkthrough');
    expect(rendererMain).toContain('DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE');
    expect(rendererMain).toContain('DESKTOP_ONBOARDING_COMMANDS.DISMISS');
    expect(rendererMain).toContain('showFirstRunWalkthrough');
    // Optional chaining is required because the walkthrough is intentionally
    // skipped when the renderer bootstrap fallback is showing — the command
    // palette must still be safe to construct in that case.
    expect(rendererMain).toContain(
      'canOpen: () => !firstRunWalkthrough?.isVisible()',
    );
    // The desktop wrapper now delegates wa-dialog wiring to the host-neutral
    // helper in `src/shared/wa/walkthroughDialog.ts`. The wrapper supplies
    // copy + classes; the shared helper owns the dialog lifecycle so both
    // hosts (extension webview + Electron renderer) share the same focus,
    // dismiss, and shortcut-interception behavior.
    expect(rendererOnboarding).toContain('createWalkthroughDialog');
    expect(rendererOnboarding).toContain('Welcome to TeXRA Desktop');
    expect(sharedWalkthrough).toContain("document.createElement('wa-dialog')");
    expect(sharedWalkthrough).toContain(
      "dialog.addEventListener('wa-after-show'",
    );
    expect(sharedWalkthrough).toContain(
      "dialog.addEventListener('wa-after-hide'",
    );
    expect(sharedWalkthrough).toContain("dialog.addEventListener('keydown'");
    expect(sharedWalkthrough).toContain('isCommandPaletteShortcut(event)');
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
