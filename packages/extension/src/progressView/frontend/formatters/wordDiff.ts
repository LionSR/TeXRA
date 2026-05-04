/**
 * Word-level diff utilities using diff-match-patch.
 * Provides clean inline highlighting for text changes.
 */

// Third-party imports
import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch';

// Local imports - Lit utilities
import { html, type TemplateResult } from './litTemplates';

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

/** Generate inline diff template showing changes between old and new text. */
export function generateInlineDiff(
  oldText: string,
  newText: string,
): TemplateResult {
  const dmp = getDmp();
  const diffs = dmp.diff_main(oldText ?? '', newText ?? '');
  dmp.diff_cleanupSemantic(diffs);

  return html`${diffs.map(([op, text]: [number, string]) => {
    switch (op) {
      case DIFF_DELETE:
        return html`<span class="diff-inline-del">${text}</span>`;
      case DIFF_INSERT:
        return html`<span class="diff-inline-add">${text}</span>`;
      default:
        return text;
    }
  })}`;
}
