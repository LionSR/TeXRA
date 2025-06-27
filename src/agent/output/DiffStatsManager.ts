// Standard library imports
// Third-party imports
import { diff_match_patch } from 'diff-match-patch';

// Local imports
import { WorkspaceFS } from '@utils/files';
import type { DiffStats } from '@/types/DiffTypes';

/**
 * Provides utilities for computing diff statistics between files.
 */
export class DiffStatsManager {
  // Helper to consistently count lines in text
  private countLines(text: string): number {
    if (text.length === 0) return 0;
    return text.endsWith('\n')
      ? text.split('\n').length - 1
      : text.split('\n').length;
  }

  /**
   * Compute added and removed line counts relative to a base file.
   * Returns an empty object when stats cannot be computed.
   */
  async computeDiffStats(
    baseFile: string | null,
    outputFile: string,
  ): Promise<DiffStats> {
    try {
      if (!baseFile) {
        const outContent = await WorkspaceFS.readFile(outputFile);
        const added = this.countLines(outContent);
        return { added };
      }

      const [baseContent, outContent] = await Promise.all([
        WorkspaceFS.readFile(baseFile),
        WorkspaceFS.readFile(outputFile),
      ]);

      const dmp = new diff_match_patch();
      const diffs = dmp.diff_main(baseContent, outContent);
      let added = 0;
      let removed = 0;

      for (const [op, text] of diffs) {
        if (op === 1) {
          added += this.countLines(text);
        } else if (op === -1) {
          removed += this.countLines(text);
        }
      }

      return { added, removed };
    } catch {
      return {};
    }
  }
}

export default DiffStatsManager;
