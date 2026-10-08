import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('@texra/shared/hostBridge', () => ({ postMessage: mocks.postMessage }));
import type { SkillsTab } from '@settingsView/frontend/tabs/SkillsTab';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

useLitComponentTestDom(() => import('@settingsView/frontend/tabs/SkillsTab'));

describe('skills catalog', () => {
  beforeEach(() => mocks.postMessage.mockClear());
  it('keeps source controls and skill controls distinct while browsing the shared catalog', async () => {
    const tab = await mountComponent<SkillsTab>('skills-tab', {
      masterEnabled: true,
      disabledSkills: ['unrelated'],
      disabledSources: ['user'],
      skills: [
        {
          name: 'review',
          label: 'Review',
          sourcePath: '/bundled/review',
          description: 'Review a manuscript',
          scope: 'bundled',
          path: '/bundled/review/SKILL.md',
          enabled: true,
        },
        {
          name: 'proof',
          label: 'Proof',
          sourcePath: '/user/proof',
          description: 'Check a proof',
          scope: 'user',
          path: '/user/proof/SKILL.md',
          enabled: false,
        },
      ],
    });
    const catalog = tab.shadowRoot!.querySelector('settings-catalog')!;
    await catalog.updateComplete;
    const root = catalog.shadowRoot!;
    expect(root.querySelectorAll('.catalog-row')).toHaveLength(2);
    root.querySelector<HTMLElement>('.catalog-row-toggle')!.click();
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      {
        key: WorkspaceStateKey.DISABLED_SKILLS,
        value: ['unrelated', 'review'],
      },
    );
    const source = root.querySelector('wa-select')!;
    source.value = 'User';
    source.dispatchEvent(new Event('change', { bubbles: true }));
    await catalog.updateComplete;
    await tab.updateComplete;
    expect(root.querySelectorAll('.catalog-row')).toHaveLength(1);
    expect(
      tab.shadowRoot!.querySelector('#skill-detail-name')?.textContent,
    ).toBe('proof');
    expect(
      root.querySelector('.catalog-row-toggle')?.hasAttribute('disabled'),
    ).toBe(true);
    const sourceToggle = tab.shadowRoot!.querySelector<
      HTMLElementTagNameMap['wa-switch']
    >('wa-switch#skill-source-user')!;
    sourceToggle.checked = true;
    sourceToggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      {
        key: WorkspaceStateKey.DISABLED_SKILL_SOURCES,
        value: [],
      },
    );
  });
});
