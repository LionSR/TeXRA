// Third-party imports
import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch';

// Local imports
import { encodeHtml } from './htmlEncoding';

export const generateInlineDiff = (oldText?: string, newText?: string) => {
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
};
