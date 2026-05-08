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

import {
  DESKTOP_DIFF_COMMANDS,
  languageForExtension,
} from '../desktopDiffMessages.js';

export interface DesktopDiffHostOptions {
  // External-editor fallback — used when the renderer is unavailable (no
  // BrowserWindow yet, or postToRenderer is not wired). Writes a unified
  // patch into a temp file and opens it via the OS, preserving the previous
  // behaviour for headless / pre-mount paths.
  openPath(filePath: string): Promise<void>;
  // Optional renderer post used to render <texra-diff-view> in-app. When set
  // the diff host prefers in-app rendering and only falls back to openPath
  // when postToRenderer throws or the renderer is gone.
  postToRenderer?: (message: unknown) => void;
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

    if (options.postToRenderer) {
      try {
        options.postToRenderer({
          command: DESKTOP_DIFF_COMMANDS.SHOW_DIFF,
          diff: {
            title,
            originalPath: original.filePath,
            proposedPath: proposed.filePath,
            originalText: originalContent,
            proposedText: proposedContent,
            language: languageForExtension(path.extname(proposed.filePath)),
          },
        });
        return { original, proposed, title };
      } catch (error) {
        // postToRenderer is fire-and-forget through Electron's IPC; the only
        // realistic failure is a destroyed webContents. Fall through to the
        // external-editor path below so the user still sees the diff.
        console.error(
          'desktopDiffHost: postToRenderer failed, falling back to external editor',
          error,
        );
      }
    }

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
