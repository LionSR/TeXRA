import { diff_match_patch } from 'diff-match-patch';
import * as difflib from 'difflib';

interface RepetitionResult {
  massiveRepetitionDetected: boolean;
  ratio: number;
  longestMatch: string;
}

/**
 * Checks for massive repetition using diff-match-patch
 */
export function checkRepetitionDMP(
  lastResponse: string,
  newResponse: string,
): RepetitionResult {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(lastResponse, newResponse);

  // Find longest common substring
  let longestMatch = '';
  for (const [type, text] of diffs) {
    if (type === 0 && text.length > longestMatch.length) {
      longestMatch = text;
    }
  }

  // Calculate similarity ratio
  const matchLength = diffs.reduce(
    (sum, [type, text]) => (type === 0 ? sum + text.length : sum),
    0,
  );
  const ratio =
    (2.0 * matchLength) / (lastResponse.length + newResponse.length);
  const massiveRepetitionDetected = longestMatch.length > 1000;

  return {
    massiveRepetitionDetected,
    ratio,
    longestMatch,
  };
}

/**
 * Checks for massive repetition using difflib (similar to Python implementation)
 */
export function checkRepetitionDifflib(
  lastResponse: string,
  newResponse: string,
): RepetitionResult {
  const sequenceMatcher = new difflib.SequenceMatcher(
    null,
    lastResponse,
    newResponse,
  );
  const ratio = sequenceMatcher.ratio();
  const match = sequenceMatcher.findLongestMatch(
    0,
    lastResponse.length,
    0,
    newResponse.length,
  );
  const longestMatch = lastResponse.slice(match[0], match[0] + match[2]);
  const massiveRepetitionDetected = longestMatch.length > 1000;

  return {
    massiveRepetitionDetected,
    ratio,
    longestMatch,
  };
}

/**
 * Example usage with logging:
 */
export function logMassiveRepetition(result: RepetitionResult): void {
  if (result.massiveRepetitionDetected) {
    console.error(`Repetition ratio: ${result.ratio}`);
    console.error(`Longest matching substring: ${result.longestMatch}`);
    console.error('Massive repetition detected - stopping process.');
  }
}

/**
 * Adds CDATA sections to specified XML tags
 * @param xmlData The XML content as string
 * @param tags Array of tag names to wrap with CDATA
 * @returns Modified XML string with CDATA sections
 */
export function addCdataToTags(xmlData: string, tags: string[]): string {
  return tags.reduce((data, tag) => {
    const pattern = new RegExp(`(<${tag}>)(.*?)(<\/${tag}>)`, 'gs');
    return data.replace(pattern, '$1<![CDATA[$2]]>$3');
  }, xmlData);
}

/**
 * Adds CDATA sections to specified XML tags, supporting tags with attributes
 * @param xmlData The XML content as string
 * @param tags Array of tag names to wrap with CDATA
 * @returns Modified XML string with CDATA sections
 */
export function addCdataToTagsMultiple(
  xmlData: string,
  tags: string[],
): string {
  return tags.reduce((data, tag) => {
    const pattern = new RegExp(
      `(<${tag}(?:\\s+[^>]*)?>)(.*?)(<\/${tag}>)`,
      'gs',
    );
    return data.replace(pattern, '$1<![CDATA[$2]]>$3');
  }, xmlData);
}
