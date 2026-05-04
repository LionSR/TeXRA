/**
 * History view styles - re-exports shared history/search styles.
 *
 * The canonical definitions live in @shared/styles/historyStyles.ts.
 * Components in this directory import from here for locality.
 */

// Re-export the combined array as historyViewStyles for backward compatibility.
// historyStyles = [searchStyles, historyListStyles] — Lit supports nested arrays.
export { historyStyles as historyViewStyles } from '@shared/styles/historyStyles';
