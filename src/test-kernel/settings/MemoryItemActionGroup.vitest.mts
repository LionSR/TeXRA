// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component type
import type { MemoryItem } from '@settingsView/frontend/components/memory/MemoryItem';

// Local imports - shared schemas
import type { MemoryViewItem } from '@shared/schemas/memoryViewMessages';

// Local imports - test utilities
import { useLitComponentTestDom } from './litComponentTestUtils';

function makeItem(overrides: Partial<MemoryViewItem> = {}): MemoryViewItem {
  return {
    displayPath: 'notes.md',
    storagePath: '/memory/notes.md',
    size: 42,
    mtime: new Date(0).toISOString(),
    ...overrides,
  };
}

async function mount(item: MemoryViewItem): Promise<MemoryItem> {
  const element = document.createElement('memory-item') as MemoryItem;
  element.item = item;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

/**
 * Regression coverage for the wa-button-group + tooltip consolidation onto
 * `renderIconActionButtonParts` (src/shared/wa/actionButtons.ts): the
 * pin/open/delete cluster must keep rendering one `<wa-tooltip>` per grouped
 * button and keep dispatching the same memory-view events on click.
 */
describe('memory-item action group', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/components/memory/MemoryItem'),
  );

  it('renders each grouped action as a wa-button with a matching sibling tooltip', async () => {
    const element = await mount(makeItem());

    const deleteButton = element.shadowRoot?.querySelector<HTMLElement>(
      '#memory-delete-button',
    );
    expect(deleteButton).toBeTruthy();
    expect(deleteButton?.tagName).toBe('WA-BUTTON');
    expect(deleteButton?.getAttribute('aria-label')).toBe('Delete');

    const deleteTooltip = element.shadowRoot?.querySelector(
      'wa-tooltip[for="memory-delete-button"]',
    );
    expect(deleteTooltip?.textContent).toBe('Delete this memory');
  });

  it('flips the pin button label/tooltip/icon based on item.pinned', async () => {
    const element = await mount(makeItem({ pinned: true }));

    const pinButton =
      element.shadowRoot?.querySelector<HTMLElement>('#memory-pin-button');
    expect(pinButton?.getAttribute('aria-label')).toBe('Unpin');
    const pinTooltip = element.shadowRoot?.querySelector(
      'wa-tooltip[for="memory-pin-button"]',
    );
    expect(pinTooltip?.textContent).toBe('Unpin this memory');
  });

  it('dispatches memory-delete-item on delete-button click', async () => {
    const element = await mount(makeItem());
    const events: unknown[] = [];
    element.addEventListener('memory-delete-item', (event) => {
      events.push((event as CustomEvent).detail);
    });

    const deleteButton = element.shadowRoot?.querySelector<HTMLElement>(
      '#memory-delete-button',
    );
    deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toEqual([
      { storagePath: '/memory/notes.md', displayPath: 'notes.md' },
    ]);
  });
});
