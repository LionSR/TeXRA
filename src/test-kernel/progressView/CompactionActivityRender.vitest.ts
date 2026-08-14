// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { CompactionActivity } from '@progressView/frontend/components/CompactionActivity';
import {
  COMPACTION_ACTIVITY_LABEL,
  type CompactionActivityStatus,
} from '@shared/streams/compactionActivityProjection';

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

    const row = query(element, '.activity');
    expect(row?.getAttribute('role')).toBe('status');
    expect(row?.getAttribute('aria-live')).toBe('polite');
    expect(query(element, '.label')?.textContent).toBe(
      COMPACTION_ACTIVITY_LABEL.running,
    );

    const spinner = query(element, '.icon');
    expect(spinner?.tagName).toBe('WA-SPINNER');
    // The row announces via role="status"; hide the spinner from AT.
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');

    // The dash stroke lives on .indicator inside the spinner shadow root.
    const litSpinner = spinner as
      (Element & { updateComplete?: Promise<unknown> }) | null | undefined;
    await litSpinner?.updateComplete;
    const reducedMotion = spinner?.shadowRoot?.querySelector(
      'style[data-texra-reduced-motion]',
    );
    expect(reducedMotion?.textContent).toContain('.indicator');
    expect(reducedMotion?.textContent).toMatch(/animation:\s*none/);
  });

  it('keeps the reduced-motion override on the shared spinner', async () => {
    const { CompactionActivity: Component } =
      await import('@progressView/frontend/components/CompactionActivity');

    // designTokens also mention prefers-reduced-motion, so pin the
    // component-owned rule rather than the joined stylesheet text.
    const componentStyle = Component.styles?.at(-1);
    const cssText =
      typeof componentStyle === 'string'
        ? componentStyle
        : (componentStyle?.cssText ?? '');
    const collapsed = cssText.replaceAll(/\s+/g, ' ').trim();

    expect(collapsed).toContain(
      '@media (prefers-reduced-motion: reduce) { wa-spinner::part(base) { animation: none; } }',
    );
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
