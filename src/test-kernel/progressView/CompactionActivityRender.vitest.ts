// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { CompactionActivity } from '@progressView/frontend/components/CompactionActivity';
import type { CompactionActivityStatus } from '@shared/streams/compactionActivityProjection';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

const NON_RUNNING_ICONS: Record<
  Exclude<CompactionActivityStatus, 'running'>,
  string
> = {
  completed: 'circle-check',
  failed: 'circle-xmark',
  cancelled: 'ban',
  skipped: 'circle-info',
  interrupted: 'circle-exclamation',
};

function mount(status: CompactionActivityStatus): Promise<CompactionActivity> {
  return mountComponent<CompactionActivity>('compaction-activity', { status });
}

function query<T extends Element>(
  element: CompactionActivity,
  selector: string,
): T | null | undefined {
  return element.shadowRoot?.querySelector<T>(selector);
}

describe('compaction-activity render branches', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/CompactionActivity'),
  );

  it('renders an aria-hidden wa-spinner while running', async () => {
    const element = await mount('running');

    const spinner = query(element, '.icon');
    expect(spinner?.tagName).toBe('WA-SPINNER');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    // The row already announces via role="status"; no nested progressbar.
    expect(query(element, '[role="progressbar"]')).toBeFalsy();
  });

  it('keeps the reduced-motion override on the shared spinner', async () => {
    const { CompactionActivity: Component } =
      await import('@progressView/frontend/components/CompactionActivity');

    const cssText = Component.styles
      ?.map((style) => (typeof style === 'string' ? style : style.cssText))
      .join('\n');

    expect(cssText).toContain('prefers-reduced-motion');
    expect(cssText).toContain('wa-spinner::part(base)');
    expect(cssText).toContain('animation: none');
  });

  it('renders the expected status icon for every non-running status', async () => {
    for (const [status, iconName] of Object.entries(NON_RUNNING_ICONS)) {
      const element = await mount(status as CompactionActivityStatus);

      const icon = query(element, '.icon');
      expect(icon?.tagName, `status=${status}`).toBe('WA-ICON');
      expect(icon?.getAttribute('name'), `status=${status}`).toBe(iconName);
    }
  });
});
