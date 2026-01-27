// Local imports - shared schemas
import { createEvent } from '@shared/utils/events';
import type { MemoryItemActionDetail } from '@shared/schemas';

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
