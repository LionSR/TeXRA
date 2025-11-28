/**
 * Tool-specific configuration constants.
 *
 * Single source of truth for file limits, extraction limits,
 * buffer sizes, and other tool-related configuration across the codebase.
 */

// =============================================================================
// File Reading Limits
// =============================================================================

/** Maximum number of lines the ReadTool will return */
export const READ_FILE_MAX_LINES = 2000;

// =============================================================================
// Attachment Limits
// =============================================================================

/** Maximum file size for tool attachments (15 MiB) */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;

// =============================================================================
// LaTeX Extraction Limits
// =============================================================================

/** Maximum number of bibliography entries to return */
export const EXTRACT_BIBLIOGRAPHY_MAX_ENTRIES = 25;

/** Maximum number of TikZ figures to extract and compile */
export const EXTRACT_TIKZ_MAX_FILES = 12;

/** Maximum number of figure files to return from extraction */
export const EXTRACT_FIGURES_MAX_FILES = 20;

// =============================================================================
// Buffer and Output Size Limits
// =============================================================================

/** Maximum number of events to buffer when no listeners are registered */
export const MAX_EVENT_BUFFER_SIZE = 1000;

/** Maximum length for command output truncation */
export const MAX_OUTPUT_LENGTH = 150;

/** Maximum length for error details before truncation */
export const MAX_ERROR_LENGTH = 500;

// =============================================================================
// Path/Directory Constants
// =============================================================================

/** Prefix for pasted image filenames */
export const PASTED_PREFIX = 'pasted_';

/** Directory name for storing pasted images */
export const PASTED_DIR = 'pasted';

/** Directory name for storing task run artifacts */
export const TASK_RUNS_DIR = 'taskRuns';

/** Directory name for storing history */
export const HISTORY_DIR = 'History';

/** Default directory name for custom agents */
export const DEFAULT_CUSTOM_AGENTS_DIR = 'custom_agents';

/** Directory name for storing audio recordings */
export const RECORDINGS_DIR = 'recordings';

/** Directory name for storing tool-use session snapshots */
export const TOOL_USE_SESSIONS_DIR = 'toolUseSessions';

// =============================================================================
// Tool Snapshot Constants
// =============================================================================

/** Current version of tool-use snapshot format */
export const TOOL_USE_SNAPSHOT_VERSION = 1;
