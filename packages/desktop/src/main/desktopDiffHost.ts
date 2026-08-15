import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

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

/**
 * Upper bound on how long `dispose()` waits for in-flight fallback setup
 * before proceeding to remove already-recorded temp directories. A hung
 * read of an arbitrary path must not block app quit indefinitely.
 */
export const DIFF_HOST_FALLBACK_SETUP_TIMEOUT_MS = 5_000;

export function createDesktopDiffHost(
  options: DesktopDiffHostOptions,
): Pick<DiffViewHost, 'openDiff'> & { dispose(): Promise<void> } {
  // External-editor patch files live under a fresh temp directory per diff.
  // That directory cannot be removed as soon as `openPath` settles because the
  // OS editor may still be reading it, so each fallback run records its
  // directory here and `dispose()` removes them when the window closes.
  const externalPatchDirs = new Set<string>();
  // One removal promise per temp directory. Both the fallback error path and
  // `dispose()` request removals, and sharing the promise avoids two
  // concurrent recursive `rm` calls on the same path (which can fail with
  // `EBUSY`/`EPERM` on Windows). The memo is cleared when the removal settles
  // so a failed removal can be retried instead of caching a rejection.
  const pendingRemovals = new Map<string, Promise<void>>();
  // Fallback setup in flight: the read/compute/temp-dir-creation prefix of
  // `openDiff`, tracked from the start of the call. `dispose()` awaits these
  // so the quit lifecycle also waits for the `disposed` branch below, which
  // can start its removal only after this setup finishes.
  const inFlightFallbacks = new Set<Promise<void>>();
  // Set when dispose() starts. A fallback still in flight checks this before
  // recording its temp directory: the set has already been snapshotted and
  // cleared, so recording would leak the directory.
  let disposed = false;

  function removeTempDir(tempDir: string): Promise<void> {
    const pending = pendingRemovals.get(tempDir);
    if (pending) return pending;
    const removal = rm(tempDir, { recursive: true, force: true }).finally(
      () => {
        pendingRemovals.delete(tempDir);
      },
    );
    pendingRemovals.set(tempDir, removal);
    return removal;
  }

  // Returns an idempotent settle function for a promise held in
  // `inFlightFallbacks`. The promise resolves only, so callers never have to
  // handle a rejection from the bookkeeping slot.
  function trackFallbackSetup(): () => void {
    let settle!: () => void;
    const setup = new Promise<void>((resolve) => {
      settle = resolve;
    });
    inFlightFallbacks.add(setup);
    void setup.finally(() => inFlightFallbacks.delete(setup));
    return settle;
  }

  // Waits for fallback setup that was already in flight when `dispose()`
  // started, up to a fixed bound. The loop re-snapshots the set because an
  // `openDiff` can register after the first snapshot; those late calls still
  // self-clean through the `disposed` branch once their setup finishes.
  async function drainFallbackSetups(): Promise<void> {
    const deadline = Date.now() + DIFF_HOST_FALLBACK_SETUP_TIMEOUT_MS;
    while (inFlightFallbacks.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const abort = new AbortController();
      try {
        await Promise.race([
          Promise.allSettled([...inFlightFallbacks]),
          sleep(remainingMs, undefined, { signal: abort.signal }),
        ]);
      } finally {
        abort.abort();
      }
    }
  }

  async function openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
  ): Promise<DiffSession> {
    const settleFallbackSetup = trackFallbackSetup();
    try {
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
        // The window closed while this fallback was in flight and dispose()
        // has already drained the record set, so recording the directory now
        // would leak it. Remove it immediately and stop instead.
        try {
          await removeTempDir(tempDir);
        } catch (cleanupError) {
          console.warn(
            `[desktop] Failed to remove the temporary diff directory after the window closed: ${toErrorMessage(cleanupError)}`,
          );
        }
        throw new Error(
          'Desktop window closed before the diff could be opened.',
        );
      }
      externalPatchDirs.add(tempDir);
      // From here dispose() owns the directory through `externalPatchDirs`,
      // so the fallback setup no longer needs its own dispose-time wait.
      settleFallbackSetup();
      const diffPath = path.join(tempDir, `${nanoid()}.diff`);

      try {
        await writeFile(diffPath, patch, 'utf8');
        await options.openPath(diffPath);
      } catch (error) {
        // The patch never reached an editor: clean it up now instead of
        // waiting for window close, and preserve the original failure for the
        // caller. Keep the directory recorded when the removal fails so
        // dispose() can retry it, and log instead of swallowing the failure.
        try {
          await removeTempDir(tempDir);
          externalPatchDirs.delete(tempDir);
        } catch (cleanupError) {
          console.warn(
            `[desktop] Failed to remove the temporary diff directory; will retry when the window closes: ${toErrorMessage(cleanupError)}`,
          );
        }
        throw error;
      }

      return { original, proposed, title };
    } finally {
      settleFallbackSetup();
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;
    // Wait for fallbacks that were setting up when the window closed, bounded
    // so a hung read cannot block quit forever. A setup that had not yet
    // created its temp directory now sees `disposed` and removes it itself;
    // awaiting that cleanup here (up to the bound) keeps the quit lifecycle
    // from resolving before the post-disposal removal finishes.
    await drainFallbackSetups();

    const tempDirs = [...externalPatchDirs];
    externalPatchDirs.clear();
    const firstResults = await Promise.allSettled(
      tempDirs.map((tempDir) => removeTempDir(tempDir)),
    );
    const firstFailures = tempDirs.filter(
      (_, index) => firstResults[index].status === 'rejected',
    );
    if (firstFailures.length === 0) return;

    // A transient `EBUSY`/`EPERM` on the shared error-path removal would
    // otherwise leave the directory untracked, because `dispose()` cleared
    // `externalPatchDirs` before the shared attempt settled. Retry each
    // failure once; the per-path memo was cleared when the first attempt
    // settled, so the retry issues a fresh `rm`.
    const retryResults = await Promise.allSettled(
      firstFailures.map((tempDir) => removeTempDir(tempDir)),
    );
    const stillFailed = firstFailures.filter(
      (_, index) => retryResults[index].status === 'rejected',
    );
    if (stillFailed.length > 0) {
      // `dispose()` runs once per host, so there is no later cleanup pass that
      // can read a re-recorded directory. Surface the failure loudly and leave
      // the directories to the OS temp-directory cleanup instead of
      // pretending another dispose will retry them.
      throw new AggregateError(
        retryResults
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          )
          .map((failure) => failure.reason),
        `Failed to remove ${stillFailed.length} diff temp ${
          stillFailed.length === 1 ? 'directory' : 'directories'
        }; the directories are left for OS temp cleanup.`,
      );
    }
  }

  return { openDiff, dispose };
}
