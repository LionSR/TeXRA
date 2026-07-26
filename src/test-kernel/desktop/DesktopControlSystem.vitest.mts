// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.mjs';

function read(relativePath: string): string {
  return readFileSync(repoPath(relativePath), 'utf8');
}

describe('desktop control system', () => {
  it('defines one three-step control scale and disabled-state opacity', () => {
    const tokens = read('packages/desktop/src/renderer/themeTokens.css');

    expect(tokens).toMatch(/--control-size-s:\s*24px/);
    expect(tokens).toMatch(/--control-size-m:\s*28px/);
    expect(tokens).toMatch(/--control-size-l:\s*32px/);
    expect(tokens).toMatch(/--opacity-disabled:\s*0\.5/);
    expect(tokens).toContain('--font-size-sm: calc(var(--font-size) * 0.9)');
  });

  it('runs the shell on a three-step weight ramp, not raw numbers', () => {
    // Intermediate weights (550/650/750) are the failure mode: they read as
    // noise on a variable font and round to the neighbouring step on a static
    // one, so the same label renders at different weights per platform.
    const tokens = read('packages/desktop/src/renderer/themeTokens.css');
    const shellCss = read('packages/desktop/src/renderer/taskShell.css');
    const lightDom = read('packages/desktop/src/renderer/styles.css');

    expect(tokens).toMatch(/--font-weight-medium:\s*500/);
    expect(tokens).toMatch(/--font-weight-semibold:\s*600/);
    for (const css of [shellCss, lightDom]) {
      expect(css).not.toMatch(/font-weight:\s*\d/);
    }
  });

  it('mirrors interactive states and decorative icon surfaces across light and shadow DOM', () => {
    const lightDom = read('packages/desktop/src/renderer/styles.css');
    const shadowDom = read('src/shared/styles/controlStyles.ts');
    const commonView = read('src/shared/styles/commonViewStyles.ts');

    for (const css of [lightDom, shadowDom]) {
      expect(css).toContain('.btn-primary');
      expect(css).toContain('.btn-secondary');
      expect(css).toContain('.btn-ghost');
      expect(css).toContain('.icon-button');
      expect(css).toContain(':active');
      expect(css).toContain("[aria-pressed='true']");
      expect(css).toContain('[disabled]');
      expect(css).toContain('.icon-surface');
      expect(css).toContain('.icon-surface.is-size-s');
      expect(css).toContain('.icon-surface.is-size-m');
      expect(css).toContain('.icon-surface.is-size-l');
    }

    expect(shadowDom).toContain(
      '.action-button:not(.btn-primary):not(.btn-secondary)',
    );
    expect(lightDom).toContain(
      'wa-button.action-button:not(.btn-primary):not(.btn-secondary)',
    );
    expect(lightDom).not.toContain('desktop-primary-button');
    expect(lightDom).not.toContain('desktop-secondary-button');
    expect(shadowDom).toContain(
      'export const iconSurfaceStyles: CSSResult = css`',
    );
    expect(commonView).toContain('${iconSurfaceStyles}');
  });

  it('uses canonical control classes instead of local shell button skins', () => {
    const shellTemplate = read('packages/desktop/src/renderer/taskShell.ts');
    const renderer = read('packages/desktop/src/renderer/main.ts');
    const shellCss = read('packages/desktop/src/renderer/taskShell.css');

    expect(shellTemplate).toContain(
      'task-sidebar-brand-menu icon-button is-size-s',
    );
    expect(shellTemplate).toContain('task-sidebar-action btn-ghost');
    expect(shellTemplate).toContain('task-project-mark icon-surface is-size-m');
    expect(shellTemplate).toContain(
      'task-workbench-close icon-button is-size-m focus-ring-inset',
    );
    expect(renderer).toContain('task-header-button icon-button is-size-l');
    expect(renderer).toContain('task-environment-button btn-secondary');
    expect(renderer).toContain('class="task-environment-row"');
    expect(renderer).not.toContain('openKindAfterInteraction');
    expect(renderer).toContain('No open sources');
    expect(renderer).not.toContain('open workbench items');
    expect(shellCss).toContain('.task-workbench-tab-activate::part(base)');
    expect(shellCss).toContain('background: transparent');
    expect(shellCss).not.toMatch(/font-size:\s*\d+px/);
    expect(shellCss).not.toContain('.task-header-button::part(base)');
    expect(shellCss).not.toContain(
      '.task-workbench-tab-close:hover::part(base)',
    );
  });

  it('shares canonical prompt and overlay controls without changing route hooks', () => {
    const overlay = read('packages/desktop/src/renderer/overlayDialog.ts');
    const prompt = read('packages/desktop/src/renderer/promptOverlay.ts');

    expect(overlay).toContain("'desktop-overlay-close'");
    expect(overlay).toContain("'icon-button'");
    expect(overlay).toContain("'is-size-l'");
    expect(prompt).toContain(
      "classList.add('desktop-prompt-cancel', 'btn-secondary')",
    );
    expect(prompt).toContain(
      "classList.add('desktop-prompt-submit', 'btn-primary')",
    );
  });

  it('renders the startup team chooser inline with an explicit saved opt-out', () => {
    const panel = read('packages/desktop/src/renderer/desktopOnboarding.ts');
    const renderer = read('packages/desktop/src/renderer/main.ts');
    const messages = read('packages/desktop/src/desktopOnboardingMessages.ts');

    expect(panel).toContain('class="desktop-startup-panel"');
    expect(panel).toContain('<wa-card');
    expect(panel).toContain('<wa-checkbox');
    expect(panel).toContain("Don't show this at startup");
    expect(panel).not.toContain('<wa-dialog');
    expect(renderer).toContain('startupTeamPanel.template()');
    expect(renderer).toContain('?hidden=${startupPanelVisible}');
    expect(renderer).toContain('if (hasWorkspace) void editorPane.refresh();');
    expect(renderer).not.toContain('appRoot.append(startupTeamPanel');
    expect(messages).toContain('texra.desktop.hideStartupTeamChooser');
  });

  it('reserves macOS traffic-light space without pinning the window across Spaces', () => {
    const shellCss = read('packages/desktop/src/renderer/taskShell.css');
    const renderer = read('packages/desktop/src/renderer/main.ts');
    const electronMain = read('packages/desktop/src/main/index.ts');

    expect(renderer).toContain(
      'document.body.dataset.desktopPlatform = rendererPlatform',
    );
    expect(shellCss).toContain('height: var(--task-shell-header-height)');
    expect(shellCss).toMatch(/--macos-titlebar-safe-inset:\s*92px/);
    expect(shellCss).toContain(
      "body[data-desktop-platform='darwin'] .task-sidebar-brand",
    );
    expect(shellCss).toContain(
      'padding-left: var(--macos-titlebar-safe-inset)',
    );
    expect(shellCss).toContain(
      "body[data-desktop-platform='darwin'] .task-shell-collapsed .task-header",
    );
    expect(electronMain).not.toContain('setVisibleOnAllWorkspaces');
  });

  it('normalizes onboarding icons and button slots through shared controls', () => {
    const welcome = read(
      'packages/extension/src/webview/frontend/components/OnboardingWelcomeCard.ts',
    );

    expect(welcome).toContain('class="welcome-icon icon-surface is-size-l"');
    expect(welcome.match(/class="icon-surface is-size-s"/g)).toHaveLength(3);
    expect(welcome).toContain(
      "waIcon('comment-discussion', { slot: 'start' })",
    );
    expect(welcome).toContain("waIcon('right-to-bracket', { slot: 'start' })");
    expect(welcome).not.toContain('size="small"');
  });

  it('uses Web Awesome for every desktop command-palette control', () => {
    const palette = read(
      'packages/desktop/src/renderer/desktopCommandPalette.ts',
    );

    expect(palette).toContain('<wa-button');
    expect(palette).not.toContain('<button');
    expect(palette).toContain('<wa-input');
    expect(palette).toContain("components/dialog/dialog.js'");
  });
});
