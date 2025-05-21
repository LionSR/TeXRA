import { diffLines } from 'diff';
import { readFile } from './workspaceFileUtils';

export interface DiffStats {
  added: number;
  removed: number;
}

export async function computeDiffStats(
  baseFile: string,
  editedFile: string,
): Promise<DiffStats> {
  try {
    const [baseContent, editedContent] = await Promise.all([
      readFile(baseFile),
      readFile(editedFile),
    ]);
    const diffs = diffLines(baseContent, editedContent);
    let added = 0;
    let removed = 0;
    for (const part of diffs) {
      const lineCount = part.count ?? part.value.split(/\r?\n/).length - 1;
      if (part.added) {
        added += lineCount;
      } else if (part.removed) {
        removed += lineCount;
      }
    }
    return { added, removed };
  } catch {
    return { added: 0, removed: 0 };
  }
}
