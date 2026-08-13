import { describe, expect, it } from 'vitest';
import type { WorktreeChip } from '@progressView/frontend/components/WorktreeChip';
import type { WorktreeInfo } from '@shared/schemas';
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/WorktreeChip'),
);

function mountChip(info: WorktreeInfo): Promise<WorktreeChip> {
  return mountComponent<WorktreeChip>('worktree-chip', { info });
}

describe('worktree-chip', () => {
  it('renders a working-directory fallback when git metadata is absent', async () => {
    const element = await mountChip({
      workingDirectory: '/tmp/texra/issue-4018',
    });

    expect(element.shadowRoot?.textContent).toContain('issue-4018');
  });

  it('uses shared tooltips for PR metadata without duplicate ids', async () => {
    const element = await mountChip({
      workingDirectory: '/tmp/texra/issue-4018',
      branch: 'issue-4018',
      pr: {
        number: 42,
        state: 'open',
        title: 'Tooltip migration',
        additions: 3,
        deletions: 1,
        ciState: 'success',
      },
    });
    const shadow = element.shadowRoot!;
    const ids = [...shadow.querySelectorAll<HTMLElement>('[id]')].map(
      (node) => node.id,
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(shadow.querySelector('[title]')).toBeNull();
    expect(shadow.querySelectorAll('wa-tooltip')).toHaveLength(4);
    expect(
      shadow.querySelector('wa-tooltip[for="worktree-pr-title"]')?.textContent,
    ).toBe('Tooltip migration');
  });

  it('exposes dirty state to assistive technology', async () => {
    const element = await mountChip({
      workingDirectory: '/tmp/texra/issue-4018',
      branch: 'issue-4018',
      dirty: true,
    });

    const dirty = element.shadowRoot?.querySelector('.dirty-dot');
    expect(dirty?.getAttribute('role')).toBe('img');
    expect(dirty?.getAttribute('aria-label')).toBe('uncommitted changes');
    expect(element.shadowRoot?.textContent).toContain('uncommitted changes');
  });
});
