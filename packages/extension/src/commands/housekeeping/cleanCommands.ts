// Third-party imports
import { Effect } from 'effect';

// Local imports
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import {
  announce,
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import {
  findBuildDirectories,
  removeBuildDirectories,
} from '@housekeeping/clean';
import { fileOpResultMessage } from '@housekeeping/runDirOps';

import type { WorkflowFileOperationResult } from '@texra/controllers/session/hostRunActions';

const CHANNEL = 'cleanCommands';

/** Tell the user what the toolbar's Clean of a run's storage did. */
export const presentClean = Effect.fn('cleanCommands.presentClean')(function* ({
  result,
  inputFile,
}: WorkflowFileOperationResult): Effect.fn.Return<void> {
  const { level, text } = fileOpResultMessage('clean', result, inputFile);
  if (result.status === 'missingParams' || level === 'error') {
    yield* Effect.forkDetach(showLoggedMessage(CHANNEL, text));
  } else {
    yield* Effect.forkDetach(showLoggedInfoMessage(CHANNEL, text));
  }
});

const LISTED_BUILD_DIRECTORIES = 10;

/**
 * `texra.cleanBuild`: list every `build/` folder the command would delete,
 * ask once in a modal that names them, then report what happened. The
 * deletion is recursive and workspace-wide, so it never runs on one click.
 */
export const confirmCleanBuild = Effect.gen(function* () {
  const directories = yield* findBuildDirectories;
  if (directories.length === 0) {
    yield* Effect.forkDetach(
      showLoggedInfoMessage(
        CHANNEL,
        'No build/ folders found in this workspace.',
      ),
    );
    return;
  }
  const listed = directories.slice(0, LISTED_BUILD_DIRECTORIES);
  const more = directories.length - listed.length;
  const detail = [
    ...listed.map((dir) => `${dir}/`),
    ...(more > 0 ? [`…and ${more} more`] : []),
  ].join('\n');
  const noun = directories.length === 1 ? 'folder' : 'folders';
  const confirm = `Delete ${directories.length} ${noun}`;
  const confirmed = yield* announce(
    CHANNEL,
    vscodeUi.confirm(
      `Delete ${directories.length} build/ ${noun} and everything in them?`,
      { detail, confirmLabel: confirm },
    ),
    false,
  );
  if (!confirmed) return;
  const failed = yield* removeBuildDirectories(directories);
  if (failed.length > 0) {
    yield* Effect.forkDetach(
      showLoggedMessage(
        CHANNEL,
        `Could not delete ${failed.length} of ${directories.length} build/ ${noun}: ${failed.join(', ')}. See the TeXRA log for the cause.`,
      ),
    );
    return;
  }
  yield* Effect.forkDetach(
    showLoggedInfoMessage(
      CHANNEL,
      `Deleted ${directories.length} build/ ${noun}.`,
    ),
  );
});
