// Third-party imports
import { diff_match_patch } from 'diff-match-patch';

// Local imports - agent
import type { DiffStats } from '@agent/types/DiffTypes';

// Local imports
import { flexibleFS, TaskRunFileService } from '@utils/files';

export class DiffStatsManager {
  constructor(private fileService: TaskRunFileService) {}

  private countLines(text: string): number {
    if (text.length === 0) return 0;
    return text.endsWith('\n')
      ? text.split('\n').length - 1
      : text.split('\n').length;
  }

  public async computeDiffStats(
    baseFile: string | null,
    outputFile: string,
  ): Promise<DiffStats> {
    try {
      const outputLocation = this.fileService.describePath(outputFile);

      if (!baseFile) {
        const outContent = await flexibleFS.read(outputLocation);
        const added = this.countLines(outContent);
        return { added };
      }

      const baseLocation = this.fileService.describePath(baseFile);
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
    } catch {
      return {};
    }
  }
}

export type { DiffStats } from '@agent/types/DiffTypes';
