import type { MemoryItemActionDetail } from '@shared/schemas';
import { createEvent } from '@shared/utils/events';

export const MemoryViewEvents = {
  refresh: () => createEvent('memory-refresh', undefined),
  openFolder: () => createEvent('memory-open-folder', undefined),
  toggleEnabled: (detail: { enabled: boolean }) =>
    createEvent('memory-toggle-enabled', detail),
  openItem: (detail: MemoryItemActionDetail) =>
    createEvent('memory-open-item', detail),
  deleteItem: (detail: MemoryItemActionDetail) =>
    createEvent('memory-delete-item', detail),
  loadPreview: (detail: { storagePath: string }) =>
    createEvent('memory-load-preview', detail),
  pinItem: (detail: { storagePath: string }) =>
    createEvent('memory-pin-item', detail),
  unpinItem: (detail: { storagePath: string }) =>
    createEvent('memory-unpin-item', detail),
} as const;
