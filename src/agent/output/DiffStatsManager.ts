// Third-party imports
import { diff_match_patch } from 'diff-match-patch';

// Local imports - agent
import type { DiffStats } from '@agent/types/DiffTypes';

// Local imports
import { flexibleFS, type FileLocation } from '@utils/files';

export class DiffStatsManager {
  private countLines(text: string): number {
    if (text.length === 0) return 0;
    return text.endsWith('\n')
      ? text.split('\n').length - 1
      : text.split('\n').length;
  }

  public async computeDiffStats(
    baseLocation: FileLocation | null,
    outputLocation: FileLocation,
  ): Promise<DiffStats> {
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
  }
}
