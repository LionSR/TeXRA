// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component type
import type { ApproveSplitButton } from '@progressView/frontend/components/ApproveSplitButton';

// Local imports - shared copy
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

// Local imports - test utilities
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function mount(options: {
  canBypass?: boolean;
  bypassAction?: string;
  canApproveAllDelegatedWork?: boolean;
  disabled?: boolean;
}): Promise<ApproveSplitButton> {
  return mountComponent<ApproveSplitButton>('approve-split-button', {
    approveTitle: 'Approve',
    canBypass: options.canBypass ?? false,
    bypassAction:
      options.bypassAction ?? DELEGATION_APPROVAL_COPY.progressViewEditAction,
    canApproveAllDelegatedWork: options.canApproveAllDelegatedWork ?? false,
    disabled: options.disabled ?? false,
  });
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

function clickApproveButton(element: ApproveSplitButton): void {
  element.shadowRoot
    ?.querySelector<HTMLElement>('wa-button[data-action="approve"]')
    ?.dispatchEvent(new CustomEvent('click', { bubbles: true }));
}

function selectMenuItem(element: ApproveSplitButton, value: string): void {
  element.shadowRoot?.querySelector('.approve-split-menu')?.dispatchEvent(
    new CustomEvent('wa-select', {
      detail: { item: { value } },
      bubbles: true,
    }),
  );
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

    const approve = element.shadowRoot?.querySelector(
      'wa-button[data-action="approve"]',
    );
    expect(approve).toBeTruthy();
    clickApproveButton(element);
    expect(events).toStrictEqual(['approve']);
  });

  it('keeps disabled controls as a plain inert Approve button', async () => {
    const element = await mount({ canBypass: true, disabled: true });
    const approve = element.shadowRoot?.querySelector<HTMLElement>(
      'wa-button[data-action="approve"]',
    );

    expect(element.shadowRoot?.querySelector('wa-button-group')).toBeFalsy();
    expect(element.shadowRoot?.querySelector('wa-dropdown')).toBeFalsy();
    expect(approve?.hasAttribute('disabled')).toBe(true);
  });

  it('uses the native group with matching primary segments and accessible labels', async () => {
    const element = await mount({ canBypass: true });
    const group = element.shadowRoot?.querySelector('wa-button-group');
    const approve = group?.querySelector<HTMLElement>(
      'wa-button[data-action="approve"]',
    );
    const menu = group?.querySelector('wa-dropdown');
    const trigger = menu?.querySelector<HTMLElement>(
      'wa-button[slot="trigger"]',
    );

    expect(group?.getAttribute('label')).toBe('Approve');
    expect(approve?.parentElement).toBe(group);
    expect(menu?.parentElement).toBe(group);
    expect(approve?.classList.contains('action-button')).toBe(false);
    expect(approve?.getAttribute('appearance')).toBe('filled');
    expect(approve?.getAttribute('variant')).toBe('brand');
    expect(approve?.getAttribute('size')).toBe('s');
    expect(trigger?.getAttribute('appearance')).toBe('filled');
    expect(trigger?.getAttribute('variant')).toBe('brand');
    expect(trigger?.getAttribute('size')).toBe('s');
    expect(trigger?.getAttribute('aria-label')).toBe('More approve options');
    expect(element.shadowRoot?.querySelector('wa-tooltip')?.parentNode).toBe(
      element.shadowRoot,
    );
  });

  it('names only the kind the panel grants when canBypass is true', async () => {
    const element = await mount({
      canBypass: true,
      bypassAction: DELEGATION_APPROVAL_COPY.progressViewCommandAction,
    });

    expect(element.shadowRoot?.querySelector('.approve-split')).toBeTruthy();
    const item = element.shadowRoot?.querySelector<HTMLElement>(
      'wa-dropdown-item[value="approve-session"]',
    );
    expect(item).toBeTruthy();
    expect(item?.textContent).toContain(
      DELEGATION_APPROVAL_COPY.progressViewCommandAction,
    );
    expect(item?.textContent).not.toContain('file edits');
    expect(item?.textContent).not.toContain('Yolo');
    const tooltip = element.shadowRoot?.querySelector('wa-tooltip');
    expect(tooltip?.textContent).toContain(
      DELEGATION_APPROVAL_COPY.progressViewCommandAction,
    );
  });

  it('emits approve on the main button click in split mode', async () => {
    const element = await mount({ canBypass: true });
    const events = recordEvents(element);

    clickApproveButton(element);
    expect(events).toStrictEqual(['approve']);
  });

  it('emits approve-session only for the run-scoped bypass menu item', async () => {
    const element = await mount({ canBypass: true });
    const events = recordEvents(element);
    const menu = element.shadowRoot?.querySelector('.approve-split-menu');
    expect(menu).toBeTruthy();

    // An unrecognized menu value is a no-op.
    selectMenuItem(element, 'nope');
    expect(events).toStrictEqual([]);

    selectMenuItem(element, 'approve-session');
    expect(events).toStrictEqual(['approve-session']);
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
    const tooltip = element.shadowRoot?.querySelector('wa-tooltip');
    expect(tooltip?.textContent).toContain(
      DELEGATION_APPROVAL_COPY.progressViewExplanation,
    );
    expect(tooltip?.textContent).not.toMatch(/stream|yolo/i);
    selectMenuItem(element, 'approve-all-delegated-work');
    expect(events).toStrictEqual(['approve-all-delegated-work']);
  });
});
