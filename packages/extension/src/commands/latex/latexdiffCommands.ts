// Third-party imports
import { Effect, Exit, FileSystem } from 'effect';

// Local imports
import { pathToLocationIn, withLogChannel } from '@texra-ai/harness/host';
import { toErrorMessage, type FileLocation } from '@texra-ai/harness/schemas';
import {
  prepareBuildDisplay,
  scheduleViewerDisplay,
} from '@frontend/latex/openBuild';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';
import type { WorkspaceRoots } from '@texra-ai/harness';

/**
 * Open and build one generated diff, returning its resolved location and
 * whether the viewer may be scheduled for it. A generated path alone is not
 * enough: an external `compileLatex2Pdf` failure can produce a generated
 * file whose PDF is not viewer-ready.
 */
const openLatexdiffResult = Effect.fnUntraced(function* (
  roots: WorkspaceRoots,
  diffFilePath: string,
) {
  const diffLocation = pathToLocationIn(roots.workspace, diffFilePath);
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(diffLocation.absolutePath))) {
    yield* showLoggedMessage(
      CHANNEL,
      `Diff file could not be found. Expected path: ${diffFilePath}`,
    );
    return undefined;
  }

  // The file-open/build phase stays a settled step so multi-round latexdiff
  // runs keep their sequential build/show ordering and failures still reach
  // the request. The caller decides whether to schedule a viewer from
  // `viewerReady`; a generated path alone is not enough when external
  // compilation failed (#10553).
  const viewerReady = yield* prepareBuildDisplay(roots, diffLocation, {
    preserveFocus: true,
    scheduleViewer: false,
  });
  return { diffLocation, viewerReady };
});

/**
 * Restore the last successfully prepared diff as the active LaTeX document
 * before scheduling the argument-free viewer. Used whenever a later processed
 * diff changed LaTeX Workshop's current document/root but is not the intended
 * viewer target (either a later setup rejected, or the last processed diff was
 * not viewer-ready).
 */
const restorePreparedViewerTarget = (
  diffLocation: FileLocation,
): Effect.Effect<boolean> =>
  openFileInEditor(diffLocation.absolutePath, {
    preview: true,
    preserveFocus: true,
  }).pipe(
    Effect.as(true),
    // The original setup error still propagates; a failed restore is a reason
    // to skip the argument-free viewer rather than open a stale/unrelated PDF.
    Effect.catch((err) =>
      Effect.logWarning(
        `Failed to restore the last prepared diff before viewer handoff: ${toErrorMessage(err)}`,
      ).pipe(Effect.as(false)),
    ),
  );

/**
 * The extension's half of the latexdiff verbs (`latexdiffVerbs`): prepare
 * every generated diff in order and schedule exactly one viewer handoff, in
 * the caller's scope, for the last viewer-ready diff.
 *
 * Each file-open/build phase stays settled and serialized, so setup failures
 * reach the request. The viewer is restored to the last viewer-ready diff
 * whenever a later processed diff is not viewer-ready, including on normal
 * completion (#10553); the handoff is an `onExit` finalizer, so it runs on
 * the failing path too.
 */
export const openLatexdiffs = Effect.fnUntraced(function* (
  roots: WorkspaceRoots,
  diffPaths: readonly string[],
) {
  let lastViewerLocation: FileLocation | undefined;
  let lastProcessedLocation: FileLocation | undefined;

  yield* Effect.gen(function* () {
    for (const diffPath of diffPaths) {
      const opened = yield* openLatexdiffResult(roots, diffPath);
      if (opened) {
        lastProcessedLocation = opened.diffLocation;
        yield* Effect.logDebug(`Generated diff: ${diffPath}`);
        if (opened.viewerReady) {
          lastViewerLocation = opened.diffLocation;
        }
      }
    }
  }).pipe(
    Effect.onExit(
      Effect.fnUntraced(function* (exit) {
        if (!lastViewerLocation) return;
        let viewerTargetReady = true;
        if (
          Exit.isFailure(exit) ||
          lastProcessedLocation?.absolutePath !==
            lastViewerLocation.absolutePath
        ) {
          viewerTargetReady =
            yield* restorePreparedViewerTarget(lastViewerLocation);
        }
        if (viewerTargetReady) {
          // In the caller's scope: the viewer confirmation fires long after
          // this finalizer returns, and closing that scope cancels it.
          yield* Effect.forkScoped(scheduleViewerDisplay, {
            startImmediately: true,
          });
        }
      }),
    ),
    withLogChannel(CHANNEL),
  );
});
