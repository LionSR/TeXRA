// Node imports
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

const SETTINGS_TABS_ROOT = 'packages/extension/src/settingsView/frontend/tabs';
const SETTINGS_BANNER_TABS = [
  'AccountTab.ts',
  'AIAgentsTab.ts',
  'GoalTab.ts',
  'LaTeXTab.ts',
  'MemoryTab.ts',
  'ModelsTab.ts',
  'MultiAgentTab.ts',
  'ShortcutsTab.ts',
  'ToolsTab.ts',
] as const;

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('settings style contracts', () => {
  it('routes every top-level informational banner through one shared primitive', () => {
    for (const tab of SETTINGS_BANNER_TABS) {
      const source = read(path.join(SETTINGS_TABS_ROOT, tab));
      expect(source).toContain('renderSettingsBanner');
      expect(source).toContain('settingsBannerStyles');
      expect(source).not.toContain('settings-reminder');
      expect(source).not.toContain('<wa-callout');
    }

    const commonStyles = read('src/shared/styles/commonViewStyles.ts');
    expect(commonStyles).not.toContain('.settings-reminder');

    const bannerRenderer = read('src/shared/wa/settingsBanner.ts');
    const bannerStyles = read('src/shared/styles/bannerStyles.ts');
    expect(bannerRenderer).toContain('settings-banner-layout');
    expect(bannerRenderer).not.toContain("slot: 'icon'");
    expect(bannerStyles).toContain(
      'grid-template-columns: auto minmax(0, 1fr) auto',
    );
    expect(bannerStyles).toContain('justify-content: flex-end');
  });

  it('keeps semantic button skins in the shared action renderer', () => {
    const renderer = read('src/shared/wa/actionButtons.ts');

    expect(renderer).toContain("primary: 'btn-primary'");
    expect(renderer).toContain("secondary: 'btn-secondary'");
    expect(renderer).toContain("ghost: 'btn-ghost'");
    expect(renderer).toContain("link: 'btn-ghost is-link'");
    expect(renderer).toContain("danger: 'btn-ghost is-danger'");
  });

  it('uses one shared settings section heading treatment', () => {
    const commonStyles = read('src/shared/styles/commonViewStyles.ts');
    expect(commonStyles).toContain('.settings-section-heading');
    expect(commonStyles).toContain('.settings-section-heading-title');

    for (const component of [
      'ApiAccessSection.ts',
      'ModelSelectionList.ts',
      'ProviderKeyList.ts',
      'ReliabilitySettingsSection.ts',
    ]) {
      const source = read(
        path.join(
          'packages/extension/src/settingsView/frontend/components/profile',
          component,
        ),
      );
      expect(source).toContain('renderSettingsSectionHeading');
      expect(source).not.toMatch(/<h[1-6][\s>]/);
    }

    expect(commonStyles).not.toContain('.settings-subsection-heading');
    expect(read('src/shared/styles/controlStyles.ts')).not.toContain(
      '.settings-section-title',
    );
  });

  it('uses one disclosure-row skin for provider credentials and models', () => {
    const commonStyles = read('src/shared/styles/commonViewStyles.ts');
    expect(commonStyles).toContain('.settings-disclosure');
    expect(commonStyles).toContain('.settings-disclosure-summary');
    expect(commonStyles).toContain('.settings-disclosure-toggle');

    for (const component of ['ProviderKeyList.ts', 'ModelSelectionList.ts']) {
      const source = read(
        path.join(
          'packages/extension/src/settingsView/frontend/components/profile',
          component,
        ),
      );
      expect(source).toContain('settings-disclosure-list');
      expect(source).toContain('settings-disclosure-summary');
      expect(source).toContain('settings-disclosure-toggle');
    }

    expect(
      read(
        'packages/extension/src/settingsView/frontend/components/profile/ProviderKeyList.ts',
      ),
    ).not.toContain('<table');
  });
});
