/**
 * Pure constants that have no platform (VS Code) dependencies.
 *
 * These can be safely imported from VS Code-free zones (src/agent/, src/model/,
 * src/latex/, src/tools/, src/shared/, src/replacement/, src/eventBus/).
 *
 * Functions and settings that depend on VS Code configuration or state remain
 * in constants.ts and configUtils.ts.
 */

// Length for preview slices of tool output and responses
export const K_SLICE = 200;

// Generic preview lengths for logging and repetition checks
export const MESSAGE_PREVIEW_LENGTH = 50;
export const REPETITION_PREVIEW_LENGTH = 400;
export const REPETITION_DETECTION_THRESHOLD = 1000;

// Time constants
export const SHORT_SLEEP_MS = 50;
export const REFRESH_THRESHOLD_MS = 200;
export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// Debounce delay constants for UI responsiveness
export const DEBOUNCE_WATCHER_MS = 200; // File system watchers (fast response)
export const DEBOUNCE_OPTIONS_MS = 300; // Dropdown options refresh
export const DEBOUNCE_STATE_SAVE_MS = 500; // State persistence (slower, batched)

// Common file type constants
export const FILE_TYPES = [
  'input',
  'reference',
  'auxiliary',
  'media',
  'output',
] as const;

export type FileType = (typeof FILE_TYPES)[number];
