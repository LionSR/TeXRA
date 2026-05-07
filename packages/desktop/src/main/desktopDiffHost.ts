import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type DiffSession,
  type DiffSource,
  type DiffViewHost,
} from '@hosts/diffViewHost';
import { computeUserPatch } from '@tools/approval/toolEditApproval';

export interface DesktopDiffHostOptions {
  openPath(filePath: string): Promise<void>;
}

export function createDesktopDiffHost(
  options: DesktopDiffHostOptions,
): Pick<DiffViewHost, 'openDiff'> {
  async function openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
  ): Promise<DiffSession> {
    const [originalContent, proposedContent] = await Promise.all([
      readFile(original.filePath, 'utf8'),
      readFile(proposed.filePath, 'utf8'),
    ]);
    const patch =
      computeUserPatch(originalContent, proposedContent) ??
      `No textual changes for ${path.basename(proposed.filePath)}.\n`;
    const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-desktop-diff-'));
    const diffPath = path.join(tempDir, `${randomUUID()}.diff`);

    await writeFile(diffPath, patch, 'utf8');
    await options.openPath(diffPath);

    return { original, proposed, title };
  }

  return { openDiff };
}
