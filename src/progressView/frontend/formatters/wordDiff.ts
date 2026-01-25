/**
 * Word-level diff utilities using diff-match-patch.
 * Provides clean inline highlighting for text changes.
 */

// Third-party imports
import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch';

// Local imports - shared utilities
import { encodeHtml } from '@shared/utils/html';

// Type alias for the diff_match_patch instance
type DiffMatchPatch = InstanceType<typeof diff_match_patch>;

// Singleton diff_match_patch instance - reused across calls to avoid allocation overhead
let dmpInstance: DiffMatchPatch | null = null;

function getDmp(): DiffMatchPatch {
  if (!dmpInstance) {
    dmpInstance = new diff_match_patch();
  }
  return dmpInstance;
}

/** Generate inline diff HTML showing changes between old and new text. Uses diff-match-patch for reliable diffing. */
export function generateInlineDiff(oldText: string, newText: string): string {
  const dmp = getDmp();
  const diffs = dmp.diff_main(oldText ?? '', newText ?? '');
  dmp.diff_cleanupSemantic(diffs);

  return diffs
    .map(([op, text]: [number, string]) => {
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
