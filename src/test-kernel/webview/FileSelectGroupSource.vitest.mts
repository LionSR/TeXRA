// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test paths
import { repoPath } from '../desktop/desktopTestPaths.mjs';

function readFileSelectGroup(): string {
  return readFileSync(
    repoPath(
      'packages/extension/src/webview/frontend/components/FileSelectGroup.ts',
    ),
    'utf8',
  );
}

function readMainApp(): string {
  return readFileSync(
    repoPath('packages/extension/src/webview/frontend/MainApp.ts'),
    'utf8',
  );
}

function readFileSelectStyles(): string {
  return readFileSync(
    repoPath(
      'packages/extension/src/webview/frontend/styles/fileSelectStyles.ts',
    ),
    'utf8',
  );
}

describe('file select groups', () => {
  it('always renders the file list instead of hiding it behind a toggle', () => {
    const component = readFileSelectGroup();
    const mainApp = readMainApp();
    const styles = readFileSelectStyles();

    expect(component).toContain('class="multiple-files-container"');
    expect(component).not.toContain('handleToggleList');
    expect(component).not.toContain('config.toggleTitle');
    expect(component).not.toContain('waIcon(chevronName)');
    expect(component).not.toContain('data-expanded=');
    expect(mainApp).not.toContain('@toggle-list=');
    expect(styles).not.toContain('.file-select[data-expanded');
  });
});
