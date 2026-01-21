/**
 * Word-level diff utilities using diff-match-patch.
 * Provides clean inline highlighting for text changes.
 */

import DiffMatchPatch from 'diff-match-patch';
import { encodeHtml } from '@common/htmlEncoding.js';

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

/**
 * Generate inline diff HTML showing changes between old and new text.
 * Uses Google's diff-match-patch for reliable diffing.
 *
 * @param {string} oldText - Original text
 * @param {string} newText - New text
 * @returns {string} HTML string with inline diff highlighting
 */
export function generateInlineDiff(oldText, newText) {
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);

  return diffs
    .map(([op, text]) => {
      const encoded = encodeHtml(text);
      switch (op) {
        case DIFF_DELETE:
          return `<span class="diff-inline-del">${encoded}</span>`;
        case DIFF_INSERT:
          return `<span class="diff-inline-add">${encoded}</span>`;
        default:
          return encoded;
      }
    })
    .join('');
}
