import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Cause, Effect, Exit } from 'effect';
import { nanoid } from 'nanoid';

import { type DiffSource, type DiffViewHost } from '@hosts/uiHosts';
import { effectRuntime } from '@platform/processRuntime';
import { workspaceRoots } from '@platform/workspaceRoots';
import { monacoLanguageForPath } from '@shared/monaco/monacoLanguage';
import { computeLineChangeSummary } from '@tools/approval/toolEditApproval';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { unifiedDiffText } from '@utils/text/unifiedDiff';
import { createTexraTempDir } from '@utils/files/tempDir';

import {
  DESKTOP_DIFF_COMMANDS,
  type DesktopShowDiffMessage,
} from '../shared/desktopDiffMessages.js';
import {
  tryShowInRenderer,
  type DesktopOverlayPostOptions,
} from './desktopIpcTypes.js';

interface DesktopDiffHostOptions extends DesktopOverlayPostOptions {
  /**
   * Falls back to the OS default editor (writes a `.diff` patch file and
   * calls `openPath`). Used when the renderer overlay is unavailable.
   */
  openPath(filePath: string): Promise<void>;
  /**
   * Records the temp directory holding an external-editor patch file. The
   * directory cannot be removed as soon as `openPath` settles because the OS
   * editor may still be reading the patch, so removal belongs to the process
   * that outlives the window (on macOS the app outlives every window), which
   * removes the recorded directories once during quit.
   */
  recordPatchDir(tempDir: string): void;
}

export function createDesktopDiffHost(
  options: DesktopDiffHostOptions,
): Pick<DiffViewHost, 'openDiff'> {
  async function openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
  ): Promise<void> {
    const [originalContent, proposedContent] = await Promise.all([
      readFile(original.filePath, 'utf8'),
      readFile(proposed.filePath, 'utf8'),
    ]);
    const lineChanges = computeLineChangeSummary(
      originalContent,
      proposedContent,
    );

    // Prefer the in-app Review workbench when wired. A `false` return value
    // or a thrown error opts into the external-editor fallback (covers the
    // startup IPC race and a destroyed BrowserWindow).
    const shownInRenderer = tryShowInRenderer(
      { ...options, source: 'desktopDiffHost', fallback: 'external editor' },
      {
        command: DESKTOP_DIFF_COMMANDS.SHOW_DIFF,
        session: workspaceRoots().storage,
        title,
        displayPath: title.replace(/^Tool edit:\s*/, ''),
        originalText: originalContent,
        proposedText: proposedContent,
        additions: lineChanges.added,
        deletions: lineChanges.removed,
        language: monacoLanguageForPath(proposed.filePath ?? ''),
      } satisfies DesktopShowDiffMessage,
    );
    if (shownInRenderer) return;

    // External-editor fallback: write a unified patch file and open it.
    const diffBody = unifiedDiffText(originalContent, proposedContent);
    const patch = diffBody
      ? `--- ${original.filePath}\n+++ ${proposed.filePath}\n${diffBody}\n`
      : `No textual changes for ${path.basename(proposed.filePath)}.\n`;
    const tempDir = await createTexraTempDir('texra-desktop-diff-');
    options.recordPatchDir(tempDir);
    const diffPath = path.join(tempDir, `${nanoid()}.diff`);

    const opened = await effectRuntime().runPromiseExit(
      Effect.tryPromise({
        try: async () => {
          await writeFile(diffPath, patch, 'utf8');
          await options.openPath(diffPath);
        },
        catch: (error) => error,
      }),
    );
    if (Exit.isFailure(opened)) {
      // The patch never reached an editor: remove it now instead of leaving it
      // until quit, and preserve the original failure for the caller. The
      // directory stays recorded, so a failed removal is retried by the
      // process-level removal, and the failure is logged instead of swallowed.
      const removed = await effectRuntime().runPromiseExit(
        Effect.tryPromise({
          try: () => rm(tempDir, { recursive: true, force: true }),
          catch: (error) => error,
        }),
      );
      if (Exit.isFailure(removed)) {
        console.warn(
          `Failed to remove the temporary diff directory; the process-level removal at quit retries it: ${toErrorMessage(
            Cause.squash(removed.cause),
          )}`,
        );
      }
      throw Cause.squash(opened.cause);
    }
  }

  return { openDiff };
}
