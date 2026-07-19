// Third-party imports
import arxivClient from 'arxiv-client';
import { z } from 'zod';

import { normaliseArxivIdentifier } from '@latex/arxivIdentifier';

/** Infer ArxivEntry type from the client's execute() return type */
type ArxivEntry = Awaited<ReturnType<typeof arxivClient.execute>>[number];

// ============================================================================
// arXiv Paper Schemas - Single Source of Truth
// ============================================================================

/**
 * Schema for base arXiv paper metadata shared between search and metadata tools.
 */
const ArxivPaperBaseSchema = z.object({
  id: z.string().nullable(),
  doi: z.string().nullable(),
  title: z.string(),
  published: z.date().nullable(),
  updated: z.date().nullable(),
  authors: z.array(z.string()),
  primaryCategory: z.string().nullable(),
});

/** Base arXiv paper metadata - derived from schema. */
export type ArxivPaperBase = z.infer<typeof ArxivPaperBaseSchema>;

/**
 * Schema for arXiv paper metadata returned by search results.
 * Extends ArxivPaperBaseSchema with search-specific fields.
 */
const ArxivSearchResultSchema = ArxivPaperBaseSchema.extend({
  abstract: z.string().nullable(),
  arxivUrl: z.string().nullable(),
});

/** arXiv search result - derived from schema. */
export type ArxivSearchResult = z.infer<typeof ArxivSearchResultSchema>;

/**
 * Schema for detailed arXiv paper metadata with additional fields.
 * Extends ArxivPaperBaseSchema with metadata-specific fields.
 */
const ArxivPaperMetadataSchema = ArxivPaperBaseSchema.extend({
  abstract: z.string().nullish(),
  journalReference: z.string().nullable(),
  comment: z.string().nullable(),
  links: z.unknown(),
});

/** Detailed arXiv paper metadata - derived from schema. */
export type ArxivPaperMetadata = z.infer<typeof ArxivPaperMetadataSchema>;

export type ArxivClientInstance = typeof arxivClient;

export function createArxivClient(options?: unknown): ArxivClientInstance {
  const ClientCtor = arxivClient.constructor as {
    new (ctorOptions?: unknown): ArxivClientInstance;
  };
  return new ClientCtor(options);
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
