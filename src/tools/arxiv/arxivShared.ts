// Third-party imports
import arxivClient from 'arxiv-client';

import { normaliseArxivIdentifier } from '@latex/arxivIdentifier';

/** Infer ArxivEntry type from the client's execute() return type */
type ArxivEntry = Awaited<ReturnType<typeof arxivClient.execute>>[number];

// ============================================================================
// arXiv paper output shapes. These describe the JSON the tools EMIT (built
// locally from already-typed arxiv-client entries), not a parse boundary —
// so they are plain types, not Zod schemas.
// ============================================================================

/** Base arXiv paper metadata shared between search and metadata tools. */
export interface ArxivPaperBase {
  id: string | null;
  doi: string | null;
  title: string;
  published: Date | null;
  updated: Date | null;
  authors: string[];
  primaryCategory: string | null;
}

/** arXiv paper metadata returned by search results. */
export interface ArxivSearchResult extends ArxivPaperBase {
  abstract: string | null;
  arxivUrl: string | null;
}

/** Detailed arXiv paper metadata with additional fields. */
export interface ArxivPaperMetadata extends ArxivPaperBase {
  /** Included only when the caller requests the abstract. */
  abstract?: string | null;
  journalReference: string | null;
  comment: string | null;
  links: unknown;
}

export type ArxivClientInstance = typeof arxivClient;

export function createArxivClient(): ArxivClientInstance {
  const ClientCtor = arxivClient.constructor as {
    new (): ArxivClientInstance;
  };
  return new ClientCtor();
}

function extractEntryIdentifier(rawId: unknown): string | null {
  if (typeof rawId !== 'string') {
    return null;
  }
  const id = rawId.split('/abs/')[1];
  return id ? normaliseArxivIdentifier(id) : null;
}

/** Extract base paper metadata from an arXiv entry */
export function extractBasePaperMetadata(
  entry: ArxivEntry,
  maxAuthors?: number,
): ArxivPaperBase {
  const authorNames = entry.authors.map((author) => author.name);
  return {
    id: extractEntryIdentifier(entry.id),
    doi: entry.doi?.id ?? null,
    title: entry.title.trim(),
    published: entry.published ?? null,
    updated: entry.updated ?? null,
    authors:
      maxAuthors != null ? authorNames.slice(0, maxAuthors) : authorNames,
    primaryCategory: entry.primaryCategory ?? null,
  };
}
