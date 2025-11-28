/**
 * Tool-specific configuration constants.
 *
 * Single source of truth for file limits, extraction limits,
 * and other tool-related configuration across the codebase.
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
