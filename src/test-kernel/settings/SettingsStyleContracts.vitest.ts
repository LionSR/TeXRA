// Node imports
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

const SETTINGS_TABS_ROOT = 'packages/extension/src/settingsView/frontend/tabs';
const SETTINGS_PROFILE_ROOT =
  'packages/extension/src/settingsView/frontend/components/profile';
const SETTINGS_BANNER_TABS = [
  'AccountTab.ts',
  'LaTeXTab.ts',
  'ShortcutsTab.ts',
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
    expect(bannerStyles).toContain('@container settings (max-width: 720px)');
    expect(bannerStyles).toMatch(
      /\.settings-banner-actions\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?width:\s*100%;/u,
    );
    expect(bannerStyles).toContain('justify-content: flex-end');

    for (const tab of [
      'AIAgentsTab.ts',
      'GoalTab.ts',
      'MemoryTab.ts',
      'ModelsTab.ts',
      'ToolsTab.ts',
    ]) {
      const source = read(path.join(SETTINGS_TABS_ROOT, tab));
      expect(source).not.toContain('renderSettingsBanner');
      expect(source).not.toContain('settingsBannerStyles');
    }
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
      const source = read(path.join(SETTINGS_PROFILE_ROOT, component));
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
    expect(commonStyles).toMatch(
      /\.settings-disclosure-toggle::part\(label\)\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;/u,
    );

    for (const component of ['ProviderKeyList.ts', 'ModelSelectionList.ts']) {
      const source = read(path.join(SETTINGS_PROFILE_ROOT, component));
      expect(source).toContain('settings-disclosure-list');
      expect(source).toContain('settings-disclosure-summary');
      expect(source).toContain('settings-disclosure-toggle');
    }

    expect(
      read(path.join(SETTINGS_PROFILE_ROOT, 'ProviderKeyList.ts')),
    ).not.toContain('<table');
  });

  it('keeps selected agent labels readable and uses only the panel divider', () => {
    const styles = read(
      path.join(SETTINGS_PROFILE_ROOT, 'AgentSelectionPanel.styles.ts'),
    );

    expect(styles).toMatch(
      /\.agent-list-item\.selected\s*\{[\s\S]*?color:\s*var\(--wa-color-text-normal\);/u,
    );
    expect(styles).not.toMatch(/\.agent-count\s*\{[\s\S]*?border-top:/u);
  });

  it('gives the standalone settings webview a bounded scrolling viewport', () => {
    const shell = read('packages/extension/src/settingsView/index.html');
    const styles = read(
      'packages/extension/src/settingsView/frontend/styles.ts',
    );

    expect(shell).toMatch(
      /html,\s*body\s*\{[\s\S]*?height:\s*100%;[\s\S]*?body\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow:\s*hidden;/u,
    );
    expect(shell).toMatch(
      /settings-app\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;/u,
    );
    expect(styles).toMatch(
      /\.settings-panel\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*auto;/u,
    );
  });
});
