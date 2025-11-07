// Third-party imports
import arxivClient from 'arxiv-client';
import { extract as extractArxivId } from 'identifiers-arxiv';

// Local imports - none

/**
 * Base arXiv paper metadata shared between search and metadata tools.
 */
export interface ArxivPaperBase {
  id: string | null;
  doi: string | null;
  title: string;
  published: Date | null;
  updated: Date | null;
  authors: string[];
  primaryCategory: string | null;
}

/**
 * arXiv paper metadata returned by search results.
 */
export interface ArxivSearchResult extends ArxivPaperBase {
  abstract: string | null;
  arxivUrl: string | null;
}

/**
 * Detailed arXiv paper metadata with additional fields.
 */
export interface ArxivPaperMetadata extends ArxivPaperBase {
  abstract?: string | null;
  journalReference: string | null;
  comment: string | null;
  links: unknown;
}

export type ArxivClientInstance = typeof arxivClient;

export const createArxivClient = (options?: unknown): ArxivClientInstance => {
  const ClientCtor = arxivClient.constructor as {
    new (ctorOptions?: unknown): ArxivClientInstance;
  };
  return new ClientCtor(options);
};

/**
 * Normalize an arXiv identifier by extracting it from various formats.
 * Handles URLs (abs/pdf), plain IDs, arxiv: prefixes, and old/new format IDs.
 * Uses the identifiers-arxiv package for robust extraction.
 */
export const normaliseArxivIdentifier = (value: string): string => {
  // Preprocess PDF URLs since identifiers-arxiv doesn't handle them
  const preprocessed = value
    .replace(/^https?:\/\/arxiv\.org\/pdf\//, 'https://arxiv.org/abs/')
    .replace(/\.pdf$/i, '');

  const extracted = extractArxivId(preprocessed);
  return extracted[0] || value; // Fallback to original if extraction fails
};

export const extractEntryIdentifier = (rawId: unknown): string | null => {
  if (typeof rawId !== 'string') {
    return null;
  }
  const [, id] = rawId.split('/abs/');
  return id ? normaliseArxivIdentifier(id) : null;
};

export const getAuthorNames = (
  authors: unknown,
  maxAuthors?: number,
): string[] => {
  const list = Array.isArray(authors) ? authors : authors ? [authors] : [];
  const names = list
    .map((entry) => {
      if (entry && typeof entry === 'object' && 'name' in entry) {
        const value = (entry as { name?: unknown }).name;
        return typeof value === 'string' ? value : null;
      }
      return typeof entry === 'string' ? entry : null;
    })
    .filter((name): name is string => Boolean(name));
  if (typeof maxAuthors === 'number') {
    return names.slice(0, maxAuthors);
  }
  return names;
};

export const readPrimaryCategory = (primary: unknown): string | null => {
  if (!primary) {
    return null;
  }
  if (typeof primary === 'string') {
    return primary;
  }
  if (typeof primary === 'object' && primary && 'term' in primary) {
    const { term } = primary as { term?: unknown };
    return typeof term === 'string' ? term : null;
  }
  return null;
};
