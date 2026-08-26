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

  it('keeps editor dirtiness out of desktop IPC', () => {
    for (const source of [
      read('packages/desktop/src/main/index.ts'),
      read('packages/desktop/src/main/desktopWorkspaceIpc.ts'),
      read('packages/desktop/src/renderer/main.ts'),
      read('packages/desktop/src/shared/desktopWorkspaceMessages.ts'),
    ]) {
      expect(source).not.toContain('EDITOR_DIRTY_STATE');
    }
  });
});
