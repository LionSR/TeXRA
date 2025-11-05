// Third-party imports
import { XMLParser } from 'fast-xml-parser';

export interface NormalizedArxivEntry {
  arxivId: string;
  title: string;
  summary?: string;
  doi?: string;
  published?: string;
  updated?: string;
  authors: string[];
  primaryCategory?: string;
  categories: string[];
  comment?: string;
  journalReference?: string;
  pdfUrl?: string;
  htmlUrl?: string;
}

export const arxivParser = new XMLParser({
  allowBooleanAttributes: true,
  alwaysCreateTextNode: false,
  attributeNamePrefix: '',
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: '#text',
  trimValues: true,
});

export const toArray = <T>(value: T | T[] | undefined): T[] => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const extractArxivId = (rawId: unknown, fallback: string): string => {
  if (typeof rawId !== 'string') {
    return fallback;
  }

  const match = rawId.match(/\/abs\/([^/?#]+)/);
  return match ? match[1] : fallback;
};

const normalizeAuthors = (rawAuthors: unknown): string[] =>
  toArray(rawAuthors)
    .map((author) => {
      if (typeof author === 'string') {
        return author;
      }

      if (author && typeof author === 'object' && 'name' in author) {
        const value = (author as Record<string, unknown>).name;
        return typeof value === 'string' ? value : '';
      }

      return '';
    })
    .filter((name) => name.trim().length > 0);

const normalizeLinks = (
  rawLinks: unknown,
): { pdfUrl?: string; htmlUrl?: string } => {
  const links = toArray(rawLinks).map((link) =>
    typeof link === 'object' && link !== null
      ? (link as Record<string, unknown>)
      : {},
  );

  const html = links.find((item) => item.rel === 'alternate');
  const pdf = links.find(
    (item) => item.title === 'pdf' || item.type === 'application/pdf',
  );

  return {
    htmlUrl: typeof html?.href === 'string' ? html.href : undefined,
    pdfUrl: typeof pdf?.href === 'string' ? pdf.href : undefined,
  };
};

const normalizeCategories = (entry: Record<string, unknown>): string[] => {
  const categories = new Set<string>();

  const primary = entry['arxiv:primary_category'];
  if (primary && typeof primary === 'object' && 'term' in primary) {
    const value = (primary as Record<string, unknown>).term;
    if (typeof value === 'string') {
      categories.add(value);
    }
  }

  const additional = toArray(entry.category);
  additional.forEach((item) => {
    if (item && typeof item === 'object' && 'term' in item) {
      const term = (item as Record<string, unknown>).term;
      if (typeof term === 'string') {
        categories.add(term);
      }
    }
  });

  return [...categories];
};

export const parseArxivEntry = (
  entry: unknown,
  fallbackId: string,
): NormalizedArxivEntry => {
  const record =
    entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>)
      : {};

  const arxivId = extractArxivId(record.id, fallbackId);
  const authors = normalizeAuthors(record.author);
  const { htmlUrl, pdfUrl } = normalizeLinks(record.link);
  const categories = normalizeCategories(record);

  const doiRaw = record['arxiv:doi'];
  const doi = typeof doiRaw === 'string' ? doiRaw : undefined;

  const commentRaw = record['arxiv:comment'];
  const comment = typeof commentRaw === 'string' ? commentRaw : undefined;

  const journalRaw = record['arxiv:journal_ref'];
  const journalReference =
    typeof journalRaw === 'string' ? journalRaw : undefined;

  const primaryCategory = categories[0];

  return {
    arxivId,
    title: typeof record.title === 'string' ? record.title : fallbackId,
    summary: typeof record.summary === 'string' ? record.summary : undefined,
    doi,
    published:
      typeof record.published === 'string' ? record.published : undefined,
    updated: typeof record.updated === 'string' ? record.updated : undefined,
    authors,
    primaryCategory,
    categories,
    comment,
    journalReference,
    pdfUrl,
    htmlUrl,
  };
};
