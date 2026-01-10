// Third-party imports
import arxivClient from 'arxiv-client';
import { extract as extractArxivId } from 'identifiers-arxiv';

/** Infer ArxivEntry type from the client's execute() return type */
type ArxivEntry = Awaited<ReturnType<typeof arxivClient.execute>>[number];

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

/** Extract author names, optionally limiting to maxAuthors */
export function getAuthorNames(
  authors: ArxivEntry['authors'],
  maxAuthors?: number,
): string[] {
  const names = authors.map((author) => author.name);
  return maxAuthors != null ? names.slice(0, maxAuthors) : names;
}

/** Normalize entry title by trimming */
export function normalizeEntryTitle(title: unknown): string {
  return String(title).trim();
}

/** Extract base paper metadata from an arXiv entry */
export function extractBasePaperMetadata(
  entry: ArxivEntry,
  maxAuthors?: number,
): ArxivPaperBase {
  const identifier = extractEntryIdentifier(entry.id);
  return {
    id: identifier,
    doi: entry.doi?.id ?? null,
    title: normalizeEntryTitle(entry.title),
    published: entry.published ?? null,
    updated: entry.updated ?? null,
    authors: getAuthorNames(entry.authors, maxAuthors),
    primaryCategory: entry.primaryCategory ?? null,
  };
}
