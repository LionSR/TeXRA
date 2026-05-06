import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { repoPath } from './desktopTestPaths.mjs';

function readSource(relativePath: string): string {
  return readFileSync(repoPath(relativePath), 'utf8');
}

describe('desktop settings surface', () => {
  it('suppresses VS Code-only settings and unsupported tabs on desktop', () => {
    const settingsApp = readSource(
      'packages/extension/src/settingsView/frontend/SettingsApp.ts',
    );

    expect(settingsApp).toContain('this.isDesktopHost()');
    expect(settingsApp).toContain('SETTINGS_TAB.MODELS');
    expect(settingsApp).toContain('Memory is not available in desktop yet');
    expect(settingsApp).toContain('History is not available in desktop yet');
    expect(settingsApp).toContain('title="Open VS Code Settings"');
    expect(settingsApp).toContain('? nothing');
  });

  it('marks desktop-specific tab capabilities before rendering child controls', () => {
    const agentsTab = readSource(
      'packages/extension/src/settingsView/frontend/tabs/AgentsTab.ts',
    );
    const agentSelectionPanel = readSource(
      'packages/extension/src/settingsView/frontend/components/profile/AgentSelectionPanel.ts',
    );
    const gitTab = readSource(
      'packages/extension/src/settingsView/frontend/tabs/GitTab.ts',
    );
    const latexTab = readSource(
      'packages/extension/src/settingsView/frontend/tabs/LaTeXTab.ts',
    );
    const desktopSettingsIpc = readSource(
      'packages/desktop/src/main/desktopSettingsIpc.ts',
    );
    const desktopMain = readSource('packages/desktop/src/main/index.ts');

    expect(agentsTab).toContain('desktopHost');
    expect(agentsTab).toContain('? nothing');
    expect(agentSelectionPanel).toContain('builtIn && !this.desktopHost');
    expect(agentSelectionPanel).toContain('isCustom && !this.desktopHost');
    expect(gitTab).toContain('this.desktopHost');
    expect(gitTab).toContain('GitHub personal access token');
    expect(latexTab).toContain("dep.key !== 'latexWorkshopInstalled'");
    expect(desktopSettingsIpc).toContain('options.revealPath ??');
    expect(desktopMain).toContain('shell.showItemInFolder(filePath)');
  });
});
