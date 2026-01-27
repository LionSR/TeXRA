// Local imports - shared schemas
import type { MemoryItemActionDetail } from '@shared/schemas';

function createEvent<T>(type: string, detail: T): CustomEvent<T> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}

export const MemoryViewEvents = {
  refresh: () => createEvent('memory-refresh', undefined),
  openFolder: () => createEvent('memory-open-folder', undefined),
  toggleEnabled: (enabled: boolean) =>
    createEvent('memory-toggle-enabled', { enabled }),
  openItem: (detail: MemoryItemActionDetail) =>
    createEvent('memory-open-item', detail),
  deleteItem: (detail: MemoryItemActionDetail) =>
    createEvent('memory-delete-item', detail),
} as const;
