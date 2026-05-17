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

function readRendererStyles(): string {
  return readFileSync(
    repoPath('packages/desktop/src/renderer/styles.css'),
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

describe('desktop renderer shell — three-pane layout (PRD § 6 + § 7.D)', () => {
  it('mounts the reused Lit components from the shared packages', () => {
    const rendererMain = readRendererMain();

    // Per PRD G3: both hosts import from the same packages, no per-host copy.
    expect(rendererMain).toContain("import '@webview/frontend'");
    expect(rendererMain).toContain("import '@progressView/frontend'");
    expect(rendererMain).toContain("import '@settingsView/frontend'");

    // Direct mounts, not via <progress-app>. <stream-tabs> + <stream-conversation>
    // come from the same packages as the extension. Match the tag string
    // independently of how prettier wraps the createElement() call so the
    // assertion is robust to formatter splits. Closing `[,)]` anchors the
    // tag-name token so a hypothetical `'stream-conversation-other-tag'`
    // doesn't satisfy the `'stream-conversation'` assertion.
    expect(rendererMain).toMatch(
      /document\.createElement\(\s*'main-app'\s*[,)]/,
    );
    expect(rendererMain).toMatch(
      /document\.createElement\(\s*'settings-app'\s*[,)]/,
    );
    expect(rendererMain).toMatch(
      /document\.createElement\(\s*'stream-conversation'\s*[,)]/,
    );
    expect(rendererMain).toMatch(
      /document\.createElement\(\s*'stream-tabs'\s*[,)]/,
    );
    expect(rendererMain).not.toMatch(/\brailTabs\.compact\s*=/);
  });

  it('listens for desktop route pushes from the Electron host', () => {
    const rendererMain = readRendererMain();

    expect(rendererMain).toContain('DesktopSetRouteMessageSchema.safeParse');
    expect(rendererMain).toContain('window.addEventListener');
    expect(rendererMain).toContain('document.body.dataset.desktopRoute');
  });

  it('renders the three-pane shell with rail, center, and reserved right pane', () => {
    const rendererMain = readRendererMain();
    const styles = readRendererStyles();

    expect(rendererMain).toContain('class="desktop-three-pane"');
    expect(rendererMain).toContain('class="desktop-rail"');
    expect(rendererMain).toContain('class="desktop-center"');
    expect(rendererMain).toContain('class="desktop-right"');
    // Center swaps between launcher and conversation panes.
    expect(rendererMain).toContain('data-pane="launcher"');
    expect(rendererMain).toContain('data-pane="conversation"');

    // Three-pane CSS grid template — left rail width, flexible center,
    // collapsed right column reserved for future diff/approve UX.
    expect(styles).toContain('--desktop-rail-width: clamp(');
    expect(styles).toContain(
      'grid-template-columns: var(--desktop-rail-width)',
    );
  });

  it('renders concise empty-state guidance for first launch and no sessions', () => {
    const rendererMain = readRendererMain();
    const styles = readRendererStyles();

    expect(rendererMain).toContain('desktop-empty-workspace-capabilities');
    expect(rendererMain).toContain(
      'Run workflow or tool-use agents with the chosen model.',
    );
    expect(rendererMain).toContain('desktop-empty-streams');
    expect(rendererMain).toContain('Try: <q>polish the abstract</q>');
    expect(rendererMain).toContain('openCommandPalette');
    expect(rendererMain).not.toContain('SETTINGS_TAB.MODELS');
    expect(rendererMain).not.toContain('SETTINGS_TAB.AGENTS');
    expect(styles).toContain('.desktop-launcher-surface--empty');
    expect(styles).not.toContain('.desktop-empty-streams-actions');
  });

  it('renders the launcher back action as an icon-only chrome button', () => {
    const rendererMain = readRendererMain();
    const styles = readRendererStyles();

    expect(rendererMain).toMatch(/class="[^"]*\bdesktop-icon-button\b[^"]*"/);
    expect(rendererMain).toContain(
      "title=${commandTitle('texra.showMainView', 'Back to launcher')}",
    );
    expect(rendererMain).toContain('aria-label="Back to launcher"');
    expect(rendererMain).toMatch(
      /waIcon\('arrow-left',\s*\{\s*label:\s*'Back to launcher'\s*\}\)/,
    );
    expect(rendererMain).toContain('waIcon(spec.icon, { label: spec.label })');
    expect(rendererMain).not.toContain('TEXRA_ICON_LIBRARY');
    expect(rendererMain).not.toContain('desktop-back-button');
    expect(rendererMain).not.toContain(
      "${waIcon('arrow-left', { slot: 'start' })} Launcher",
    );
    expect(styles).not.toContain('wa-button.desktop-back-button::part(base)');
  });

  it('mounts settings as a wa-dialog overlay (not a route)', () => {
    const rendererMain = readRendererMain();
    const styles = readRendererStyles();

    expect(rendererMain).toContain("createElement('wa-dialog')");
    expect(rendererMain).toContain('desktop-settings-overlay');
    expect(rendererMain).toContain('openSettingsOverlay');
    // PRD § 6: full-window dialog (no header chrome).
    expect(styles).toContain('wa-dialog.desktop-settings-overlay');
    expect(styles).toContain('100vw');
    expect(styles).toContain('100vh');
  });

  it('mounts logs as a wa-drawer (not a route)', () => {
    const rendererMain = readRendererMain();
    const styles = readRendererStyles();

    expect(rendererMain).toContain("createElement('wa-drawer')");
    expect(rendererMain).toContain('desktop-logs-drawer');
    expect(rendererMain).toContain('openLogsDrawer');
    expect(styles).toContain('wa-drawer.desktop-logs-drawer');
  });

  it('routes legacy desktop:setRoute IPC onto the new surfaces', () => {
    const rendererMain = readRendererMain();

    // 'main' / 'progress' map to the center pane; 'settings' opens the
    // overlay; 'logs' opens the drawer. The four-route tab bar is gone.
    expect(rendererMain).toContain("case 'settings':");
    expect(rendererMain).toContain('openSettingsOverlay()');
    expect(rendererMain).toContain("case 'logs':");
    expect(rendererMain).toContain('openLogsDrawer()');
  });

  it('drives progress messages via the shared messageDispatcher', () => {
    const rendererMain = readRendererMain();

    // PRD § 7.C: <progress-app> is NOT mounted on Electron. The renderer
    // listens for progress messages directly and dispatches them through
    // the shared module.
    expect(rendererMain).toContain('dispatchMessage');
    expect(rendererMain).toContain(
      "from '@progressView/frontend/messageDispatcher'",
    );
    expect(rendererMain).toContain(
      "from '@progressView/frontend/progressState'",
    );
  });

  it('mounts the catalog-backed command palette', () => {
    const rendererMain = readRendererMain();

    expect(rendererMain).toContain('createDesktopCommandPalette');
    expect(rendererMain).toContain('openCommandPalette');
    expect(rendererMain).toContain('buildDesktopSettingsTabMessage');
    expect(rendererMain).toContain('showSettings: openSettingsTab');
  });

  it('adds platform-formatted shortcut hints to desktop chrome tooltips', () => {
    const rendererMain = readRendererMain();

    expect(rendererMain).toContain('formatDesktopAccelerator');
    expect(rendererMain).toContain('getDesktopCommandMenuEntries');
    expect(rendererMain).toContain("from './rendererPlatform'");
    expect(rendererMain).not.toContain('function getRendererPlatform');
    expect(rendererMain).toContain(
      "shortcutTitle('Commands', 'CommandOrControl+K')",
    );
    expect(rendererMain).toContain(
      'DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER',
    );
    expect(rendererMain).toContain("commandTitle('texra.openSettings'");
  });

  it('mounts desktop-only first-run onboarding controls', () => {
    const rendererMain = readRendererMain();
    const rendererOnboarding = readRendererOnboarding();
    const sharedWalkthrough = readSharedWalkthroughDialog();

    expect(rendererMain).toContain('createFirstRunWalkthrough');
    expect(rendererMain).toContain('DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE');
    expect(rendererMain).toContain('DESKTOP_ONBOARDING_COMMANDS.DISMISS');
    expect(rendererMain).toContain('showFirstRunWalkthrough');
    expect(rendererMain).toContain(
      'canOpen: () => !firstRunWalkthrough?.isVisible()',
    );
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

  it('preserves streamed setup terminal output on completion', () => {
    const rendererMain = readRendererMain();

    expect(rendererMain).toContain(
      'payload.output.length > setupTerminalOutputText.length',
    );
    expect(rendererMain).not.toContain(
      'payload.output || setupTerminalOutputText',
    );
  });

  it('does not import the deleted workspace-explorer surface', () => {
    const rendererMain = readRendererMain();
    expect(rendererMain).not.toContain('desktopWorkspaceExplorer');
    expect(rendererMain).not.toContain('DESKTOP_WORKSPACE_EXPLORER_COMMANDS');
    expect(rendererMain).not.toContain('REQUEST_TREE');
    expect(rendererMain).not.toContain('id="desktop-explorer"');
  });
});
