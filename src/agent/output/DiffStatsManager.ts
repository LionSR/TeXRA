// Third-party imports
import { diff_match_patch } from 'diff-match-patch';

// Local imports - agent
import type { DiffStats } from '@agent/types/DiffTypes';

// Local imports
import { flexibleFS, type FileLocation } from '@utils/files';

export class DiffStatsManager {
  private countLines(text: string): number {
    if (!text) return 0;
    const lines = text.split('\n');
    return text.endsWith('\n') ? lines.length - 1 : lines.length;
  }

  public async computeDiffStats(
    baseLocation: FileLocation | null,
    outputLocation: FileLocation,
  ): Promise<DiffStats> {
    try {
      if (!baseLocation) {
        const outContent = await flexibleFS.read(outputLocation);
        const added = this.countLines(outContent);
        return { added };
      }

      const [baseContent, outContent] = await Promise.all([
        flexibleFS.read(baseLocation),
        flexibleFS.read(outputLocation),
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
    } catch (error) {
      // File read errors are expected (e.g., file not found during processing)
      // Return empty stats rather than propagating the error
      return {};
    }
  }
}
