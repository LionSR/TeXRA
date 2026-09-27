import path from 'node:path';

import { Cause, Effect, FileSystem, type PlatformError } from 'effect';
import { nanoid } from 'nanoid';

import {
  ExternalOpenFailed,
  type DiffSource,
  type DiffViewHost,
} from '@hosts/uiHosts';
import {
  type ProcessRuntime,
  withProcessServices,
} from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { monacoLanguageForPath } from '@shared/monaco/monacoLanguage';
import { countLineChanges } from '@tools/approval/toolEditApproval';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  buildDiffHunks,
  reportDiffTimeout,
  unifiedDiffText,
} from '@utils/text/unifiedDiff';

import {
  DESKTOP_DIFF_COMMANDS,
  type DesktopCloseDiffMessage,
  type DesktopShowDiffMessage,
} from '../shared/desktopDiffMessages.js';
import {
  tryShowInRenderer,
  type DesktopOverlayPostOptions,
} from './desktopIpcTypes.js';

/**
 * The temp directories holding the external-editor patch files of every
 * window's diff host. A directory cannot be removed as soon as `openPath`
 * settles because the OS editor may still be reading the patch, so removal
 * belongs to the process that outlives the window (on macOS the app outlives
 * every window): {@link removeExternalDiffPatchDirs} runs once during quit.
 */
const externalPatchDirs = new Set<string>();

/**
 * Removes every recorded patch directory, reporting each failure instead of
 * swallowing it: a directory that survives is left for OS temp cleanup, and
 * quit must not stall on it.
 */
export const removeExternalDiffPatchDirs: Effect.Effect<
  void,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tempDirs = [...externalPatchDirs];
  externalPatchDirs.clear();
  yield* Effect.forEach(
    tempDirs,
    (tempDir) =>
      fs.remove(tempDir, { recursive: true, force: true }).pipe(
        Effect.catch((error: PlatformError.PlatformError) =>
          Effect.sync(() => {
            console.warn(
              `[desktop] Failed to remove the temporary diff directory ${tempDir}; it is left for OS temp cleanup: ${toErrorMessage(error.reason.cause ?? error)}`,
            );
          }),
        ),
      ),
    { concurrency: 'unbounded', discard: true },
  );
});

interface DesktopDiffHostOptions extends DesktopOverlayPostOptions {
  /**
   * Falls back to the OS default editor (writes a `.diff` patch file and
   * calls `openPath`). Used when the renderer overlay is unavailable.
   */
  openPath(filePath: string): Effect.Effect<void, Error>;
  /** The process runtime the window was handed. The members below are
   *  programs the caller runs, so this only supplies the filesystem they
   *  read and write through — nothing settles here. */
  runtime: ProcessRuntime;
}

/** The pair of Review-tab verbs one open project's diffs are shown under. */
interface ProjectDiffHost extends DiffViewHost {
  /**
   * Show a diff in the Review workbench under `previewId`, the key
   * {@link ProjectDiffHost.closeDiff} closes it by. A caller with nothing to
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
  ): Effect.Effect<void, Error>;
  /**
   * Close the diff `previewId` names: the renderer's `desktop:closeDiff`,
   * the counterpart of the `desktop:showDiff` that opened it. The Review
   * pane holds a review per path, so this takes off the ones this diff
   * opened and leaves the rest standing; the workbench tab goes only once
   * the pane is empty.
   */
  closeDiff(previewId: string): Effect.Effect<void>;
}

/** The window's diff host: one per Review surface, bound per open project. */
interface DesktopDiffHost {
  /**
   * The Review verbs of the project rooted at `roots`, whose storage root is
   * the session key the renderer files a review under.
   *
   * The host itself is built once per window, while a window shows several
   * open projects at once — so the project cannot be read off the calling
   * context here. The window binds one of these per project beside the
   * preview host's `openBuildDisplayIn`, from the same `session.roots`, which
   * is what keeps a run in a hidden project posting to its own Review pane
   * instead of the shown one's.
   */
  inProject(roots: Pick<WorkspaceRoots, 'storage'>): ProjectDiffHost;
}

export function createDesktopDiffHost(
  options: DesktopDiffHostOptions,
): DesktopDiffHost {
  function openDiff(
    reviewSession: string,
    original: DiffSource,
    proposed: DiffSource,
    title: string,
    previewId: string = nanoid(),
  ): Effect.Effect<void, Error> {
    return withProcessServices(
      options.runtime,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Both sides of a diff are absolute paths their caller chose — a run's
        // output, an accepted file, a temp copy — so they are read through the
        // process filesystem rather than through either rooted view.
        const [originalContent, proposedContent] = yield* Effect.all(
          [
            fs.readFileString(original.filePath),
            fs.readFileString(proposed.filePath),
          ],
          { concurrency: 2 },
        );
        // Compare opens pairs no approval diffed, so this diff reports its
        // own timeout; the counts fold the same hunks.
        const diff = buildDiffHunks(originalContent, proposedContent);
        yield* reportDiffTimeout(diff.timeout);
        const lineChanges = countLineChanges(diff.hunks);

        // Prefer the in-app Review workbench when wired. A `false` return value
        // or a thrown error opts into the external-editor fallback (covers the
        // startup IPC race and a destroyed BrowserWindow).
        const shownInRenderer = tryShowInRenderer(
          {
            ...options,
            source: 'desktopDiffHost',
            fallback: 'external editor',
          },
          {
            command: DESKTOP_DIFF_COMMANDS.SHOW_DIFF,
            session: reviewSession,
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
        const { text: diffBody, timeout } = unifiedDiffText(
          originalContent,
          proposedContent,
        );
        yield* reportDiffTimeout(timeout);
        const patch = diffBody
          ? `--- ${original.filePath}\n+++ ${proposed.filePath}\n${diffBody}\n`
          : `No textual changes for ${path.basename(proposed.filePath)}.\n`;
        const tempDir = yield* fs.makeTempDirectory({
          prefix: 'texra-desktop-diff-',
        });
        externalPatchDirs.add(tempDir);
        const diffPath = path.join(tempDir, `${nanoid()}.diff`);

        yield* Effect.gen(function* () {
          yield* fs.writeFileString(diffPath, patch);
          yield* options.openPath(diffPath).pipe(
            Effect.mapError(
              (cause) =>
                new ExternalOpenFailed({
                  kind: 'path',
                  target: diffPath,
                  message: 'The patch file could not be opened.',
                  cause,
                }),
            ),
          );
        }).pipe(
          // The patch never reached an editor: remove it now instead of
          // leaving it until quit, and let the original failure travel on to
          // the caller. The directory stays recorded, so a failed removal is
          // retried by the process-level removal, and it is logged instead of
          // swallowed.
          Effect.onError(() =>
            fs.remove(tempDir, { recursive: true, force: true }).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  console.warn(
                    `Failed to remove the temporary diff directory; the process-level removal at quit retries it: ${toErrorMessage(
                      Cause.squash(cause),
                    )}`,
                  );
                }),
              ),
            ),
          ),
        );
      }),
    );
  }

  /**
   * Nothing is posted when the renderer is unreachable, which is the
   * external-editor fallback's own path: a patch file opened in the OS
   * editor is not a view this host can close, and the directory holding it
   * is removed at quit.
   */
  function closeDiff(
    reviewSession: string,
    previewId: string,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      tryShowInRenderer(
        {
          ...options,
          source: 'desktopDiffHost',
          fallback: 'no in-app review tab to close',
        },
        {
          command: DESKTOP_DIFF_COMMANDS.CLOSE_DIFF,
          session: reviewSession,
          previewId,
        } satisfies DesktopCloseDiffMessage,
      );
    });
  }

  return {
    inProject: (roots) => ({
      openDiff: (original, proposed, title, previewId) =>
        openDiff(roots.storage, original, proposed, title, previewId),
      closeDiff: (previewId) => closeDiff(roots.storage, previewId),
    }),
  };
}
