// Local imports - utilities
import { extractTextFromTag } from '@utils/text/xmlExtraction';

export function extractCompactionSummary(text: string): string {
  const extracted = extractTextFromTag(text, 'summary').trim();
  const normalized = extracted || text.trim();
  return normalized;
}
