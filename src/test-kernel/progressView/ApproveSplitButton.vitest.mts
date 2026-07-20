// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component type
import type { ApproveSplitButton } from '@progressView/frontend/components/ApproveSplitButton';

// Local imports - shared copy
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

async function mount(options: {
  canBypass?: boolean;
  canApproveAllDelegatedWork?: boolean;
}): Promise<ApproveSplitButton> {
  const element = document.createElement(
    'approve-split-button',
  ) as ApproveSplitButton;
  element.approveTitle = 'Approve';
  element.canBypass = options.canBypass ?? false;
  element.canApproveAllDelegatedWork =
    options.canApproveAllDelegatedWork ?? false;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function recordEvents(element: ApproveSplitButton): string[] {
  const events: string[] = [];
  element.addEventListener('approve', () => events.push('approve'));
  element.addEventListener('approve-session', () =>
    events.push('approve-session'),
  );
  element.addEventListener('approve-all-delegated-work', () =>
    events.push('approve-all-delegated-work'),
  );
  return events;
}

describe('approve-split-button', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/ApproveSplitButton'),
  );

  it('renders a plain Approve button (no menu) when canBypass is false', async () => {
    const element = await mount({});
    const events = recordEvents(element);

    expect(element.shadowRoot?.querySelector('.approve-split')).toBeFalsy();
    expect(element.shadowRoot?.querySelector('wa-dropdown-item')).toBeFalsy();

    const approve = element.shadowRoot?.querySelector<HTMLElement>(
      'wa-button[data-action="approve"]',
    );
    expect(approve).toBeTruthy();
    approve?.dispatchEvent(new CustomEvent('click', { bubbles: true }));
    expect(events).toEqual(['approve']);
  });

  it('renders the Yolo split menu when canBypass is true', async () => {
    const element = await mount({ canBypass: true });

    expect(element.shadowRoot?.querySelector('.approve-split')).toBeTruthy();
    const item = element.shadowRoot?.querySelector<HTMLElement>(
      'wa-dropdown-item[value="approve-session"]',
    );
    expect(item).toBeTruthy();
    expect(item?.textContent).toContain('Yolo (this session)');
  });

  it('emits approve on the main button click in split mode', async () => {
    const element = await mount({ canBypass: true });
    const events = recordEvents(element);

    const approve = element.shadowRoot?.querySelector<HTMLElement>(
      'wa-button[data-action="approve"]',
    );
    approve?.dispatchEvent(new CustomEvent('click', { bubbles: true }));
    expect(events).toEqual(['approve']);
  });

  it('emits approve-session only for the Yolo menu item', async () => {
    const element = await mount({ canBypass: true });
    const events = recordEvents(element);
    const menu = element.shadowRoot?.querySelector('.approve-split-menu');
    expect(menu).toBeTruthy();

    // An unrecognized menu value is a no-op.
    menu?.dispatchEvent(
      new CustomEvent('wa-select', {
        detail: { item: { value: 'nope' } },
        bubbles: true,
      }),
    );
    expect(events).toEqual([]);

    menu?.dispatchEvent(
      new CustomEvent('wa-select', {
        detail: { item: { value: 'approve-session' } },
        bubbles: true,
      }),
    );
    expect(events).toEqual(['approve-session']);
  });

  it('names and emits the delegated-task approve-all action', async () => {
    const element = await mount({ canApproveAllDelegatedWork: true });
    const events = recordEvents(element);
    const item = element.shadowRoot?.querySelector<HTMLElement>(
      'wa-dropdown-item[value="approve-all-delegated-work"]',
    );

    expect(item?.textContent).toContain(
      DELEGATION_APPROVAL_COPY.progressViewAction,
    );
    const menu = element.shadowRoot?.querySelector('.approve-split-menu');
    menu?.dispatchEvent(
      new CustomEvent('wa-select', {
        detail: { item: { value: 'approve-all-delegated-work' } },
        bubbles: true,
      }),
    );
    expect(events).toEqual(['approve-all-delegated-work']);
  });
});
