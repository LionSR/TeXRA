import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import {
  type DiffSession,
  type DiffSource,
  type DiffViewHost,
} from '@hosts/uiHosts';
import {
  computeLineChangeSummary,
  computeUserPatch,
} from '@tools/approval/toolEditApproval';
import { createTexraTempDir } from '@utils/files/tempDir';

import {
  DESKTOP_DIFF_COMMANDS,
  type DesktopShowDiffMessage,
  monacoLanguageForFilePath,
} from '../desktopDiffMessages.js';
import {
  tryShowInRenderer,
  type DesktopOverlayPostOptions,
} from './desktopIpcTypes.js';

export interface DesktopDiffHostOptions extends DesktopOverlayPostOptions {
  /**
   * Falls back to the OS default editor (writes a `.diff` patch file and
   * calls `openPath`). Used when the renderer overlay is unavailable or
   * `forceExternal === true`.
   */
  openPath(filePath: string): Promise<void>;
}

export function createDesktopDiffHost(
  options: DesktopDiffHostOptions,
): Pick<DiffViewHost, 'openDiff'> {
  // Renders the diff in the Review workbench (`<texra-diff-view>`), or
  // reports `false` so the caller falls back to the external editor.
  function tryShowDiffInRenderer(message: DesktopShowDiffMessage): boolean {
    return tryShowInRenderer(
      { ...options, source: 'desktopDiffHost', fallback: 'external editor' },
      message,
    );
  }

  async function openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
  ): Promise<DiffSession> {
    const [originalContent, proposedContent] = await Promise.all([
      readFile(original.filePath, 'utf8'),
      readFile(proposed.filePath, 'utf8'),
    ]);
    const lineChanges = computeLineChangeSummary(
      originalContent,
      proposedContent,
    );

    // Prefer the in-app Review workbench when wired. A `false` return value or
    // a thrown error opts into the external-editor fallback (covers the
    // startup IPC race, destroyed BrowserWindow, and `forceExternal`).
    const shownInRenderer = tryShowDiffInRenderer({
      command: DESKTOP_DIFF_COMMANDS.SHOW_DIFF,
      title,
      displayPath: title.replace(/^Tool edit:\s*/, ''),
      originalText: originalContent,
      proposedText: proposedContent,
      additions: lineChanges.added,
      deletions: lineChanges.removed,
      language: monacoLanguageForFilePath(proposed.filePath),
      originalPath: original.filePath,
      proposedPath: proposed.filePath,
    });
    if (shownInRenderer) return { original, proposed, title };

    // External-editor fallback: write a unified patch file and open it.
    const patch =
      computeUserPatch(originalContent, proposedContent) ??
      `No textual changes for ${path.basename(proposed.filePath)}.\n`;
    const tempDir = await createTexraTempDir('texra-desktop-diff-');
    const diffPath = path.join(tempDir, `${nanoid()}.diff`);

    await writeFile(diffPath, patch, 'utf8');
    await options.openPath(diffPath);

    return { original, proposed, title };
  }

  return { openDiff };
}
