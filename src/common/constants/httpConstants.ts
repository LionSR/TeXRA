/**
 * HTTP and network-related constants.
 *
 * Single source of truth for timeout values, content limits,
 * and other HTTP configuration across the codebase.
 */

// =============================================================================
// Timeout Constants (in milliseconds)
// =============================================================================

/** Default timeout for web fetch operations */
export const TIMEOUT_WEB_FETCH_MS = 30_000;

/** Default timeout for arXiv downloads */
export const TIMEOUT_ARXIV_MS = 30_000;

/** Timeout for LaTeXdiff command execution */
export const TIMEOUT_LATEXDIFF_MS = 10_000;

/** Timeout for Wolfram code execution */
export const TIMEOUT_WOLFRAM_CODE_MS = 30_000;

/** Timeout for Wolfram file execution */
export const TIMEOUT_WOLFRAM_FILE_MS = 60_000;


// =============================================================================
// HTTP Limits
// =============================================================================

/** Maximum number of redirects to follow */
export const HTTP_MAX_REDIRECTS = 5;

/** Maximum content length for HTTP responses (10 MB) */
export const HTTP_MAX_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024;
