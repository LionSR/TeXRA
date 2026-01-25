// @ts-nocheck
/**
 * Word-level diff utilities using diff-match-patch.
 * Provides clean inline highlighting for text changes.
 */

import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch';
import { encodeHtml } from '@common/modules/htmlEncoding.js';

/**
 * Generate inline diff HTML showing changes between old and new text.
 * Uses Google's diff-match-patch for reliable diffing.
 *
 * @param {string} oldText - Original text (null/undefined treated as empty)
 * @param {string} newText - New text (null/undefined treated as empty)
 * @returns {string} HTML string with inline diff highlighting
 */
export function generateInlineDiff(oldText, newText) {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(oldText ?? '', newText ?? '');
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
