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

    expect(rendererMain).toContain('DESKTOP_SHELL_COMMANDS.SET_ROUTE');
    expect(rendererMain).toContain('message.command ===');
    expect(rendererMain).toContain('window.addEventListener');
    expect(rendererMain).toContain('document.body.dataset.desktopRoute');
  });
});
