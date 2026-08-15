import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import {
  type DiffSession,
  type DiffSource,
  type DiffViewHost,
} from '@hosts/uiHosts';
import { monacoLanguageForPath } from '@shared/monaco/monacoLanguage';
import {
  computeLineChangeSummary,
  computeUserPatch,
} from '@tools/approval/toolEditApproval';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { createTexraTempDir } from '@utils/files/tempDir';

import {
  DESKTOP_DIFF_COMMANDS,
  type DesktopShowDiffMessage,
} from '../shared/desktopDiffMessages.js';
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
): Pick<DiffViewHost, 'openDiff'> & { dispose(): Promise<void> } {
  // External-editor patch files live under a fresh temp directory per diff.
  // That directory cannot be removed as soon as `openPath` settles because the
  // OS editor may still be reading it, so each fallback run records its
  // directory here and `dispose()` removes them when the window closes.
  const externalPatchDirs = new Set<string>();
  // Set when dispose() starts. A fallback still in flight checks this before
  // recording its temp directory: the set has already been snapshotted and
  // cleared, so recording would leak the directory.
  let disposed = false;

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
    const shownInRenderer = tryShowInRenderer(
      { ...options, source: 'desktopDiffHost', fallback: 'external editor' },
      {
        command: DESKTOP_DIFF_COMMANDS.SHOW_DIFF,
        title,
        displayPath: title.replace(/^Tool edit:\s*/, ''),
        originalText: originalContent,
        proposedText: proposedContent,
        additions: lineChanges.added,
        deletions: lineChanges.removed,
        language: monacoLanguageForPath(proposed.filePath ?? ''),
      } satisfies DesktopShowDiffMessage,
    );
    if (shownInRenderer) return { original, proposed, title };

    // External-editor fallback: write a unified patch file and open it.
    const patch =
      computeUserPatch(originalContent, proposedContent) ??
      `No textual changes for ${path.basename(proposed.filePath)}.\n`;
    const tempDir = await createTexraTempDir('texra-desktop-diff-');
    if (disposed) {
      // The window closed while this fallback was in flight and dispose() has
      // already drained the record set, so recording the directory now would
      // leak it. Remove it immediately and stop instead.
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn(
          `[desktop] Failed to remove the temporary diff directory after the window closed: ${toErrorMessage(cleanupError)}`,
        );
      }
      throw new Error('Desktop window closed before the diff could be opened.');
    }
    externalPatchDirs.add(tempDir);
    const diffPath = path.join(tempDir, `${nanoid()}.diff`);

    try {
      await writeFile(diffPath, patch, 'utf8');
      await options.openPath(diffPath);
    } catch (error) {
      // The patch never reached an editor: clean it up now instead of waiting
      // for window close, and preserve the original failure for the caller.
      // Keep the directory recorded when the removal fails so dispose() can
      // retry it, and log instead of swallowing the failure.
      try {
        await rm(tempDir, { recursive: true, force: true });
        externalPatchDirs.delete(tempDir);
      } catch (cleanupError) {
        console.warn(
          `[desktop] Failed to remove the temporary diff directory; will retry when the window closes: ${toErrorMessage(cleanupError)}`,
        );
      }
      throw error;
    }

    return { original, proposed, title };
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const tempDirs = [...externalPatchDirs];
    externalPatchDirs.clear();
    await Promise.all(
      tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })),
    );
  }

  return { openDiff, dispose };
}
