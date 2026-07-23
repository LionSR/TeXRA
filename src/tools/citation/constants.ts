/**
 * Constants for academic metadata API tools (arXiv, Crossref).
 */

import { CrossrefClient as CrossrefApiClient } from '@jamesgopsill/crossref-client';

/** Shared Crossref client instance — use this instead of creating new ones. */
export const CrossrefClient = new CrossrefApiClient();

// arXiv API constants
export const ARXIV_CONSTANTS = Object.freeze({
  /** Maximum number of results allowed per arXiv search request */
  MAX_RESULTS: 50,
  /** Default number of results for arXiv searches */
  DEFAULT_RESULTS: 10,
  /** Maximum number of authors to return in metadata */
  MAX_AUTHORS: 50,
  /** arXiv API rate limit: approximately 1 request per 3 seconds */
  RATE_LIMIT_DELAY_MS: 3000,
} as const);

// Crossref API constants
export const CROSSREF_CONSTANTS = Object.freeze({
  /** Maximum number of results allowed per Crossref search request */
  MAX_ROWS: 100,
  /** Default number of results for Crossref searches */
  DEFAULT_ROWS: 10,
  /** Crossref API is more lenient, but add conservative delay to be respectful */
  RATE_LIMIT_DELAY_MS: 1000,
} as const);
