// Third-party imports
import { extract as extractArxivId } from 'identifiers-arxiv';

// Local imports - none

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
