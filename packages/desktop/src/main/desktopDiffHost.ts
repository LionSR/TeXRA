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
  type DesktopCloseDiffMessage,
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

/** The pair of Review-tab verbs the main process owns. */
interface DesktopDiffHost extends Pick<DiffViewHost, 'openDiff'> {
  /**
   * Show a diff in the Review workbench under `previewId`, the key
   * {@link DesktopDiffHost.closeDiff} closes it by. A caller with nothing to
   * close later (the progress view's compare) omits it and the host mints
   * one, so every diff the renderer holds is named and no close can dismiss
   * a diff its sender did not open. Omitting it also keeps this assignable
   * to `DiffViewHost['openDiff']`, which is how the window wires it.
   */
  openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
    previewId?: string,
  ): Promise<void>;
  /**
   * Close the diff `previewId` names: the renderer's `desktop:closeDiff`,
   * the counterpart of the `desktop:showDiff` that opened it. The Review
   * pane holds a review per path, so this takes off the ones this diff
   * opened and leaves the rest standing; the workbench tab goes only once
   * the pane is empty.
   */
  closeDiff(previewId: string): Promise<void>;
}

export function createDesktopDiffHost(
  options: DesktopDiffHostOptions,
): DesktopDiffHost {
  /** The window's Review surface, which both messages below address. */
  const reviewSession = (): string => workspaceRoots().storage;

  async function openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
    previewId: string = nanoid(),
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
        session: reviewSession(),
        previewId,
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

  /**
   * Nothing is posted when the renderer is unreachable, which is the
   * external-editor fallback's own path: a patch file opened in the OS
   * editor is not a view this host can close, and the directory holding it
   * is removed at quit.
   */
  async function closeDiff(previewId: string): Promise<void> {
    tryShowInRenderer(
      {
        ...options,
        source: 'desktopDiffHost',
        fallback: 'no in-app review tab to close',
      },
      {
        command: DESKTOP_DIFF_COMMANDS.CLOSE_DIFF,
        session: reviewSession(),
        previewId,
      } satisfies DesktopCloseDiffMessage,
    );
  }

  return { openDiff, closeDiff };
}
