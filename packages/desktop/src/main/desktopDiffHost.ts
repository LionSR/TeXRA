import { Effect, FileSystem } from 'effect';
import { nanoid } from 'nanoid';

import {
  buildDiffHunks,
  type ProcessRuntime,
  withLogChannel,
  withProcessServices,
} from '@texra-ai/harness/host';
import type { DiffSource, DiffViewHost } from '@texra/hosts/uiHosts';
import { monacoLanguageForPath } from '../shared/monacoLanguage';

import {
  DESKTOP_DIFF_COMMANDS,
  type DesktopCloseDiffMessage,
  type DesktopShowDiffMessage,
} from '../shared/desktopDiffMessages.js';
import type { DesktopRenderer } from './desktopIpcTypes.js';
import type { WorkspaceRoots } from '@texra-ai/harness';

interface DesktopDiffHostOptions extends DesktopRenderer {
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
        // own timeout.
        const diff = buildDiffHunks(originalContent, proposedContent);
        if (diff.timeout !== undefined) {
          yield* Effect.logWarning(diff.timeout).pipe(
            withLogChannel('unifiedDiff'),
          );
        }
        const changed = diff.hunks.flatMap((hunk) => hunk.lines);
        options.postToRenderer({
          command: DESKTOP_DIFF_COMMANDS.SHOW_DIFF,
          session: reviewSession,
          previewId,
          title,
          displayPath: title.replace(/^Tool edit:\s*/, ''),
          originalText: originalContent,
          proposedText: proposedContent,
          additions: changed.filter((line) => line.startsWith('+')).length,
          deletions: changed.filter((line) => line.startsWith('-')).length,
          language: monacoLanguageForPath(proposed.filePath),
        } satisfies DesktopShowDiffMessage);
      }),
    );
  }

  /** Close the review `previewId` opened in the renderer. */
  function closeDiff(
    reviewSession: string,
    previewId: string,
  ): Effect.Effect<void> {
    return Effect.sync(() =>
      options.postToRenderer({
        command: DESKTOP_DIFF_COMMANDS.CLOSE_DIFF,
        session: reviewSession,
        previewId,
      } satisfies DesktopCloseDiffMessage),
    );
  }

  return {
    inProject: (roots) => ({
      openDiff: (original, proposed, title, previewId) =>
        openDiff(roots.storage, original, proposed, title, previewId),
      closeDiff: (previewId) => closeDiff(roots.storage, previewId),
    }),
  };
}
