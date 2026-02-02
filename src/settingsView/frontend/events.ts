import { createEvent } from '@shared/utils/events';

export const SettingsViewEvents = {
  // Memory events
  memoryRefresh: () => createEvent('memory-refresh', undefined),
  memoryOpenFolder: () => createEvent('memory-open-folder', undefined),
  memoryToggleEnabled: (detail: { enabled: boolean }) =>
    createEvent('memory-toggle-enabled', detail),
  memoryOpenItem: (detail: { storagePath: string }) =>
    createEvent('memory-open-item', detail),
  memoryDeleteItem: (detail: { storagePath: string; displayPath?: string }) =>
    createEvent('memory-delete-item', detail),

  // History events
  historyAction: (detail: { action: string; historyId: string }) =>
    createEvent('history-action', detail),
  historyClear: () => createEvent('history-clear', undefined),
  historySearchChange: (detail: { term: string }) =>
    createEvent('history-search-change', detail),
  historyMatchCount: (detail: { display: string }) =>
    createEvent('history-match-count', detail),

  // Profile events
  signIn: () => createEvent('profile-sign-in', undefined),
  signOut: () => createEvent('profile-sign-out', undefined),
  selectAgent: (detail: { agentName: string }) =>
    createEvent('profile-select-agent', detail),
  setApiAccessMode: (detail: { mode: 'included' | 'personal' }) =>
    createEvent('profile-api-access-mode', detail),
} as const;
