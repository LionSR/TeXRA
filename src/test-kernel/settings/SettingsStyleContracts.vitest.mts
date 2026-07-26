// Node imports
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

const SETTINGS_TABS_ROOT = 'packages/extension/src/settingsView/frontend/tabs';
const SETTINGS_BANNER_TABS = [
  'GoalTab.ts',
  'LaTeXTab.ts',
  'MemoryTab.ts',
  'ModelsTab.ts',
  'MultiAgentTab.ts',
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
  });

  it('keeps semantic button skins in the shared action renderer', () => {
    const renderer = read('src/shared/wa/actionButtons.ts');

    expect(renderer).toContain("primary: 'btn-primary'");
    expect(renderer).toContain("secondary: 'btn-secondary'");
    expect(renderer).toContain("ghost: 'btn-ghost'");
    expect(renderer).toContain("link: 'btn-ghost is-link'");
    expect(renderer).toContain("danger: 'btn-ghost is-danger'");
  });

  it('uses one shared profile subsection heading treatment', () => {
    const commonStyles = read('src/shared/styles/commonViewStyles.ts');
    expect(commonStyles).toContain('.settings-subsection-heading');

    for (const stylesheet of [
      'ApiAccessSection.styles.ts',
      'ModelSelectionList.styles.ts',
      'ProviderKeyList.styles.ts',
    ]) {
      const source = read(
        path.join(
          'packages/extension/src/settingsView/frontend/components/profile',
          stylesheet,
        ),
      );
      expect(source).not.toMatch(/^\s*h2\s*\{/m);
    }
  });
});
