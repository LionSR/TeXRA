// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

// Local imports
import type { MemoryItem } from '@settingsView/frontend/components/memory/MemoryItem';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { MemoryViewItem } from '@shared/schemas/memoryViewMessages';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

function makeItem(overrides: Partial<MemoryViewItem> = {}): MemoryViewItem {
  return {
    displayPath: 'notes.md',
    storagePath: '/memory/notes.md',
    size: 42,
    mtime: new Date(0).toISOString(),
    ...overrides,
  };
}

function mount(item: MemoryViewItem): Promise<MemoryItem> {
  return mountComponent<MemoryItem>('memory-item', { item });
}

function query<T extends Element>(
  element: MemoryItem,
  selector: string,
): T | null | undefined {
  return element.shadowRoot?.querySelector<T>(selector);
}

function tooltipText(
  element: MemoryItem,
  buttonId: string,
): string | null | undefined {
  return query(element, `wa-tooltip[for="${buttonId}"]`)?.textContent;
}

/**
 * Regression coverage for the wa-button-group + tooltip consolidation onto
 * `renderIconActionButtonParts` (src/shared/wa/actionButtons.ts): the
 * pin/open/delete cluster must keep rendering one `<wa-tooltip>` per grouped
 * button and keep posting the same settings-view commands on click.
 */
describe('memory-item action group', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/components/memory/MemoryItem'),
  );

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('renders each grouped action as a wa-button with a matching sibling tooltip', async () => {
    const element = await mount(makeItem());

    const deleteButton = query<HTMLElement>(element, '#memory-delete-button');
    expect(deleteButton).toBeTruthy();
    expect(deleteButton?.tagName).toBe('WA-BUTTON');
    expect(deleteButton?.getAttribute('aria-label')).toBe('Delete: notes.md');
    expect(tooltipText(element, 'memory-delete-button')).toBe(
      'Delete this memory',
    );
  });

  it('flips the pin button label/tooltip/icon based on item.pinned', async () => {
    const element = await mount(makeItem({ pinned: true }));

    const pinButton = query<HTMLElement>(element, '#memory-pin-button');
    expect(pinButton?.getAttribute('aria-label')).toBe('Unpin: notes.md');
    expect(tooltipText(element, 'memory-pin-button')).toBe('Unpin this memory');
  });

  it('posts deleteMemory on delete-button click', async () => {
    const element = await mount(makeItem());

    query<HTMLElement>(element, '#memory-delete-button')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        SETTINGS_VIEW_COMMANDS.DELETE_MEMORY,
        { storagePath: '/memory/notes.md', displayPath: 'notes.md' },
      ],
    ]);
  });
});
