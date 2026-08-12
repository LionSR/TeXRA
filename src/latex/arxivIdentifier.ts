import { extract as extractArxivId } from 'identifiers-arxiv';

/**
 * Normalize an arXiv identifier by extracting it from various formats.
 * Handles URLs (abs/pdf), plain IDs, arxiv: prefixes, and old/new format IDs.
 * Uses the identifiers-arxiv package for robust extraction.
 * @returns The extracted arXiv ID, or null if no ID could be extracted.
 */
export function normaliseArxivIdentifier(value: string): string | null {
  // Convert PDF URLs to abs URLs and strip .pdf suffix (identifiers-arxiv doesn't handle these)
  const preprocessed = value
    .replace(/^https?:\/\/arxiv\.org\/pdf\//, 'https://arxiv.org/abs/')
    .replace(/\.pdf$/i, '');
  const extracted = extractArxivId(preprocessed);
  return extracted[0] ?? null;
}
