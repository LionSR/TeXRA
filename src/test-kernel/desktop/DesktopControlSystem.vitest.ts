// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.ts';

function read(relativePath: string): string {
  return readFileSync(repoPath(relativePath), 'utf8');
}

describe('desktop control system', () => {
  it('keeps embedded browsing behind an explicit URL and permission policy', () => {
    const browserViews = read(
      'packages/desktop/src/main/desktopBrowserViews.ts',
    );

    // Embedded browser views only load https URLs; external opens are
    // restricted to https/http/mailto, everything else is blocked loudly.
    expect(browserViews).toContain("parsed?.protocol === 'https:'");
    expect(browserViews).toContain("protocol === 'http:'");
    expect(browserViews).toContain("protocol === 'mailto:'");
    expect(browserViews).toContain('Blocked external browser URL');
    // Web content never gets device permissions without an explicit handler.
    expect(browserViews).toContain('setPermissionRequestHandler');
    expect(browserViews).toContain('setPermissionCheckHandler');
  });

  it('republishes browser-tab titles after every title-changing navigation', () => {
    const browserViews = read(
      'packages/desktop/src/main/desktopBrowserViews.ts',
    );

    expect(browserViews).toContain("webContents.on('did-navigate', republish)");
    expect(browserViews).toContain(
      "webContents.on('did-navigate-in-page', republish)",
    );
    expect(browserViews).toContain(
      "webContents.on('page-title-updated', republish)",
    );
  });

  it('preserves renderer lifecycle cleanup and shutdown wiring', () => {
    const electronMain = read('packages/desktop/src/main/index.ts');

    expect(electronMain).toMatch(
      /webContents\.on\('did-navigate',[\s\S]*?initialRendererNavigationComplete[\s\S]*?workspaceIpc\.disposeRendererResources\(\)/u,
    );
    expect(electronMain).toMatch(
      /app\.on\('before-quit',[\s\S]*?mainWindow\.close\(\);[\s\S]*?lifecycle\.runShutdown\(\)/u,
    );
  });

  it('asks about unsaved editor changes from the renderer veto alone', () => {
    // The main process must not restore the stale dirty-state mirror that once
    // left a later close pre-armed to discard buffers without asking.
    const electronMain = read('packages/desktop/src/main/index.ts');
    const renderer = read('packages/desktop/src/renderer/main.ts');
    const workspaceIpc = read(
      'packages/desktop/src/main/desktopWorkspaceIpc.ts',
    );
    const messages = read(
      'packages/desktop/src/shared/desktopWorkspaceMessages.ts',
    );

    expect(renderer).toMatch(
      /addEventListener\('beforeunload',[\s\S]*?editorPane\.hasUnsavedChanges\(\)[\s\S]*?event\.preventDefault\(\)/u,
    );
    expect(electronMain).toMatch(
      /webContents\.on\('will-prevent-unload',[\s\S]*?showMessageBoxSync[\s\S]*?'Discard Changes'[\s\S]*?event\.preventDefault\(\)/u,
    );
    expect(
      electronMain.match(/Discard the changes and continue\?/gu),
    ).toHaveLength(1);
    expect(electronMain).not.toContain('editorHasUnsavedChanges');
    expect(electronMain).not.toContain('allowNextPreventedUnload');
    for (const source of [messages, workspaceIpc, renderer, electronMain]) {
      expect(source).not.toContain('EDITOR_DIRTY_STATE');
    }
  });

  it('keeps the supervised development relaunch handoff compatible', () => {
    const electronMain = read('packages/desktop/src/main/index.ts');
    const devLauncher = read('packages/desktop/scripts/dev.mjs');

    expect(electronMain).toMatch(
      /process\.env\.TEXRA_DESKTOP_DEV_SUPERVISED === '1'[\s\S]*?process\.send\(workspaceRelaunch\.args\)/u,
    );
    expect(devLauncher).toContain("TEXRA_DESKTOP_DEV_SUPERVISED: '1'");
    expect(devLauncher).toMatch(
      /electron\.on\('message',[\s\S]*?relaunchArgs = message[\s\S]*?launchElectron\(rendererUrl, relaunchArgs\)/u,
    );
  });
});
