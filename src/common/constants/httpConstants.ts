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
export const HTTP_TIMEOUT_WEB_FETCH_MS = 30_000;

/** Default timeout for arXiv downloads */
export const HTTP_TIMEOUT_ARXIV_MS = 30_000;

/** Timeout for LaTeXdiff command execution */
export const TIMEOUT_LATEXDIFF_MS = 10_000;

// =============================================================================
// HTTP Limits
// =============================================================================

/** Maximum number of redirects to follow */
export const HTTP_MAX_REDIRECTS = 5;

/** Maximum content length for HTTP responses (10 MB) */
export const HTTP_MAX_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024;

// =============================================================================
// MIME Type Constants
// =============================================================================

/** Default MIME type when content type cannot be determined */
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/** Supported image media types for Anthropic API */
export const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
