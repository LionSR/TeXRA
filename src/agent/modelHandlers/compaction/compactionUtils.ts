import { extractTextFromTag } from '@utils/text/xmlUtils';

export function extractSummaryText(raw: string): string {
  const extracted = extractTextFromTag(raw, 'summary');
  return extracted.trim() || raw.trim();
}
