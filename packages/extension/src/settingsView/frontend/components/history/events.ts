import { createEvent } from '@shared/utils/events';

export const HistoryViewEvents = {
  searchChange: (detail: { term: string }) =>
    createEvent('history-search-change', detail),
  searchNext: () => createEvent('history-search-next', undefined),
  searchPrev: () => createEvent('history-search-prev', undefined),
  toggleItem: (detail: { historyId: string; open: boolean }) =>
    createEvent('history-toggle', detail),
  matchCount: (detail: { display: string }) =>
    createEvent('history-match-count', detail),
  searchClearComplete: () => createEvent('search-clear-complete', undefined),
  searchNavigateComplete: () =>
    createEvent('search-navigate-complete', undefined),
} as const;
