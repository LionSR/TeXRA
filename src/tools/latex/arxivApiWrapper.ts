/**
 * Wrapper for arxiv-api-ts that fixes the single-result bug.
 *
 * The arxiv-api-ts library has a bug where it fails when the arXiv API returns
 * a single result, because the XML parser returns an object instead of an array
 * for single elements, and the library tries to call .map() on it.
 *
 * This wrapper intercepts the response and ensures entries is always an array.
 */

import { XMLParser } from 'fast-xml-parser';

const PREFIXES = {
  ALL: 'all',
  TITLE: 'ti',
  AUTHOR: 'au',
  ABSTRACT: 'abs',
  COMMENT: 'co',
  JOURNAL_REF: 'jr',
  CATEGORY: 'cat',
  REPORT_NUM: 'rn',
} as const;

const SEPARATORS = {
  AND: '+AND+',
  OR: '+OR+',
  ANDNOT: '+ANDNOT+',
} as const;

const SORT_BY = {
  RELEVANCE: 'relevance',
  LAST_UPDATED_DATE: 'lastUpdatedDate',
  SUBMITTED_DATE: 'submittedDate',
} as const;

const SORT_ORDER = {
  ASCENDING: 'ascending',
  DESCENDING: 'descending',
} as const;

interface Tag {
  name: string;
  prefix?: string;
}

interface SearchQueryParams {
  include: Tag[];
  exclude?: Tag[];
}

interface SearchOptions {
  searchQueryParams: SearchQueryParams[];
  sortBy?: string;
  sortOrder?: string;
  start?: number;
  maxResults?: number;
}

export interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  updated: string;
  authors: unknown;
  doi?: string;
  comment?: string;
  journalReference?: string;
  primaryCategory: unknown;
  categories: unknown;
  links: unknown;
}

interface SearchResponse {
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  entries: ArxivEntry[];
}

function parseArxivObject(entry: any): ArxivEntry {
  return {
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    published: entry.published,
    updated: entry.updated,
    authors: entry.author,
    doi: entry['arxiv:doi'],
    comment: entry['arxiv:comment'],
    journalReference: entry['arxiv:journal_ref'],
    primaryCategory: entry['arxiv:primary_category'],
    categories: entry['arxiv:primary_category'],
    links: entry.link,
  };
}

function parseTag({ name, prefix = PREFIXES.ALL }: Tag): string {
  if (!name || name.trim() === '') {
    throw new Error('you must specify tag name');
  }
  if (!Object.values(PREFIXES).includes(prefix as any)) {
    throw new Error(`unsupported prefix: ${prefix}`);
  }
  return `${prefix}:${name}`;
}

function parseTags({ include, exclude = [] }: SearchQueryParams): string {
  if (!Array.isArray(include) || !Array.isArray(exclude)) {
    throw new Error('include and exclude must be arrays');
  }
  if (include.length === 0) {
    throw new Error('include is a mandatory field');
  }
  return `${include.map(parseTag).join(SEPARATORS.AND)}${
    exclude.length > 0 ? SEPARATORS.ANDNOT : ''
  }${exclude.map(parseTag).join(SEPARATORS.ANDNOT)}`;
}

function getArxivUrl({
  searchQuery,
  sortBy,
  sortOrder,
  start,
  maxResults,
}: {
  searchQuery: string;
  sortBy?: string;
  sortOrder?: string;
  start: number;
  maxResults: number;
}): string {
  return `http://export.arxiv.org/api/query?search_query=${searchQuery}&start=${start}&max_results=${maxResults}${
    sortBy ? `&sortBy=${sortBy}` : ''
  }${sortOrder ? `&sortOrder=${sortOrder}` : ''}`;
}

/**
 * Search arXiv papers with proper handling of single-result responses.
 */
export async function search({
  searchQueryParams,
  sortBy,
  sortOrder,
  start = 0,
  maxResults = 10,
}: SearchOptions): Promise<SearchResponse> {
  if (!Array.isArray(searchQueryParams)) {
    throw new Error('searchQueryParams must be an array');
  }

  for (const params of searchQueryParams) {
    if (!Array.isArray(params.include)) {
      throw new Error('include tags must be an array');
    }
  }

  if (sortBy && !Object.values(SORT_BY).includes(sortBy as any)) {
    throw new Error(
      `unsupported sort by option. should be one of: ${Object.values(SORT_BY).join(' ')}`,
    );
  }

  if (sortOrder && !Object.values(SORT_ORDER).includes(sortOrder as any)) {
    throw new Error(
      `unsupported sort order option. should be one of: ${Object.values(SORT_ORDER).join(' ')}`,
    );
  }

  const searchQuery = searchQueryParams.map(parseTags).join(SEPARATORS.OR);

  const options = {
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseNodeValue: true,
    trimValues: true,
  };

  const parser = new XMLParser(options);

  const response = await fetch(
    getArxivUrl({
      searchQuery,
      sortBy,
      sortOrder,
      start,
      maxResults,
    }),
  );

  const data = await response.text();
  const parsedData = parser.parse(data);

  // FIX: Ensure entries is always an array, even for single results
  let entries =
    parsedData.feed && parsedData.feed.entry ? parsedData.feed.entry : [];
  if (!Array.isArray(entries)) {
    entries = [entries];
  }

  return {
    totalResults:
      parsedData.feed && parsedData.feed['opensearch:totalResults']
        ? parsedData.feed['opensearch:totalResults']
        : 0,
    startIndex:
      parsedData.feed && parsedData.feed['opensearch:startIndex']
        ? parsedData.feed['opensearch:startIndex']
        : 0,
    itemsPerPage:
      parsedData.feed && parsedData.feed['opensearch:itemsPerPage']
        ? parsedData.feed['opensearch:itemsPerPage']
        : 0,
    entries: entries.map(parseArxivObject),
  };
}
