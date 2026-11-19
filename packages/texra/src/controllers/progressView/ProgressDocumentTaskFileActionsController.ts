// Node imports
import path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Option } from 'effect';

// Local imports
import { acceptEditedFileReplace } from '@latex/acceptedFileTarget';
import {
  runDirUnder,
  withLogChannel,
  type AppSignals,
  type StorageFs,
  type WorkspaceFs,
  pathToLocationIn,
  reportDiffTimeout,
  unifiedDiffText,
} from '@texra-ai/harness/plugins';
import {
  meansAbsent,
  entryTypeIn,
  readNormalizedFile,
} from '@texra-ai/harness/node';
import {
  toErrorMessage,
  type RunId,
  Rejected,
} from '@texra-ai/harness/schemas';
import type { ConfirmQuestion } from '@texra/hosts/uiHosts';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import { revisionLayout } from '@texra/shared/constants/revisionLayout';
import type { ProcessServices } from '@texra-ai/harness/host';
import type { HostRunActions } from '../session/hostRunActions';
import {
  compareTarget,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import type { latexdiffVerbs } from '@texra/controllers/session/latexdiffVerbs';
import { type HostCommandFailure } from '@texra/controllers/session/hostCallFailure';
import type { WriteProjectFile } from '@texra/common/files/projectFileWrite';

const CHANNEL = 'ProgressDocumentTaskFileActions';

/**
 * One file action. Its failure channel is the host's own vocabulary: every
 * host answers a request with a tag ({@link HostCommandFailure}), so a
 * refusal a host already worded — the desktop error notice is one — travels
 * as itself and no case re-enters a runtime to finish this. It runs on the
 * process `FileSystem` its run-storage reads take, an accept announces its
 * write on the process's signal hub, and a latexdiff runs over the session's
 * rooted filesystems; both hosts' request dispatchers already carry them, so
 * it is `yield*`ed there, not finished here.
 */
type FileAction<A> = Effect.Effect<
  A,
  HostCommandFailure,
  FileSystem.FileSystem | AppSignals | ProcessServices | StorageFs | WorkspaceFs
>;

type FileActionRequest = Extract<HostCommand, { kind: 'fileAction' }>;

/** The document task toolbar's file verbs a host performs. */
export interface ProgressDocumentTaskFileActionsHost {
  /** Show `editedFile` against `baseFile` in the host's diff view. */
  openDiff(
    baseFile: string,
    editedFile: string,
    title: string,
  ): FileAction<void>;
  /** Ask a question that names its action; false when the user declines. */
  confirm(
    question: ConfirmQuestion,
  ): Effect.Effect<boolean, HostCommandFailure>;
  openDirectory(directory: string): FileAction<void>;
  showInfo(message: string): Effect.Effect<void, HostCommandFailure>;
}

interface ProgressDocumentTaskFileActionsControllerDeps {
  /** A run's rounds, as the session view holds its documents fact. */
  rounds: (runId: RunId) => readonly RoundOutput[];
  host: ProgressDocumentTaskFileActionsHost;
  /** Storage root of the session whose runs this controller acts on. */
  storageRoot: string;
  /** The window's workspace, which an accepted file's location is in. */
  workspace: string | undefined;
  /** The window's run actions this controller starts or follows up. */
  runs: Pick<HostRunActions, 'merge' | 'followUpLauncher'>;
  /** The window's latexdiff of two files. */
  latexdiff: ReturnType<typeof latexdiffVerbs>['file'];
  /** The session's writer of project files (`GuiSession.writeFile`). */
  writeFile: WriteProjectFile;
}

export class ProgressDocumentTaskFileActionsController {
  private readonly deps: ProgressDocumentTaskFileActionsControllerDeps;
  constructor(deps: ProgressDocumentTaskFileActionsControllerDeps) {
    this.deps = deps;
  }

  /** A file verb from either GUI host, over the base it names or, for a
   *  run's output, the one {@link baseOf} picks. */
  readonly handle: (request: FileActionRequest) => FileAction<void> = Effect.fn(
    'ProgressDocumentTaskFileActionsController.handle',
  )({ self: this }, function* (request: FileActionRequest) {
    const { action, file } = request;
    const base = this.baseOf(request);
    if (!file || !base) {
      return yield* new Rejected({
        reason:
          request.base.kind === 'file'
            ? 'Choose a base file and an edited file first.'
            : 'The run records no file this output revises.',
      });
    }
    switch (action) {
      case 'compare':
        return yield* this.deps.host.openDiff(
          base,
          file,
          `Compare: ${path.basename(file)} ↔ ${path.basename(base)}`,
        );
      case 'accept':
        return yield* this.acceptFile(
          file,
          base,
          request.base.kind === 'runOutput' ? request.base.runId : undefined,
        );
      case 'merge':
        return yield* this.deps.runs.merge(base, file);
      case 'latexdiff':
        return yield* this.deps.latexdiff(base, file);
    }
  });

  /**
   * The base a verb over a run's output takes: Compare and Accept the file
   * the output is compared with and accepted into ({@link compareTarget}),
   * latexdiff and Merge the run's snapshot of what it revises, the text the
   * model edited.
   */
  private baseOf({ action, file, base }: FileActionRequest) {
    if (base.kind === 'file') return base.path;
    const output = this.latestOutput(base.runId, file);
    if (output === undefined) return undefined;
    return action === 'compare' || action === 'accept'
      ? compareTarget(output)
      : output.lineage?.base.absolutePath;
  }

  readonly openRunStorage: (runId: RunId) => FileAction<void> = Effect.fn(
    'ProgressDocumentTaskFileActionsController.openRunStorage',
  )(
    { self: this },
    function* (runId: RunId) {
      const runDirectory = runDirUnder(this.deps.storageRoot, runId);
      const fs = yield* FileSystem.FileSystem;
      if ((yield* entryTypeIn(fs, runDirectory)) === undefined) {
        yield* fs.makeDirectory(runDirectory, { recursive: true });
      }
      yield* this.deps.host.openDirectory(runDirectory);
    },
    Effect.catch((error) =>
      Effect.logError('Failed to open run folder', error).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(
          Effect.fail(
            new Rejected({
              reason: `Failed to open run folder: ${toErrorMessage(error)}`,
            }),
          ),
        ),
      ),
    ),
  );

  private readonly acceptFile: (
    file: string,
    base: string,
    activeRun?: RunId,
  ) => FileAction<void> = Effect.fn(
    'ProgressDocumentTaskFileActionsController.acceptFile',
  )({ self: this }, function* (file: string, base: string, activeRun?: RunId) {
    const { host, workspace, writeFile } = this.deps;
    // The content the accept wrote, read once by the write itself, so the
    // diff the launching chat is told of is exactly what was accepted.
    const written = yield* acceptEditedFileReplace(
      pathToLocationIn(workspace, base),
      pathToLocationIn(workspace, file),
      {
        confirm: (message) => host.confirm({ message, action: 'Replace file' }),
        showInfo: host.showInfo,
        write: writeFile,
      },
    );
    if (Option.isNone(written) || !activeRun) return;
    const edit = yield* this.userEdit(activeRun, file, written.value);
    if (edit !== undefined)
      yield* this.deps.runs.followUpLauncher(activeRun, edit);
  });

  /**
   * The note telling a task's launcher what the user changed of the model's
   * version of `file` (`revisionLayout(...).modelCopy`) in `accepted`, the
   * content the accept wrote; none
   * when they changed nothing or the run kept no model version (a run from
   * an earlier build, or an output outside the workspace and the run).
   */
  private userEdit(
    stream: RunId,
    file: string,
    accepted: string,
  ): Effect.Effect<string | undefined, never, FileSystem.FileSystem> {
    const output = this.latestOutput(stream, file);
    const copyPath =
      output && revisionLayout(output.round).modelCopy(output.location);
    if (output === undefined || copyPath === undefined) return Effect.undefined;
    const runDirectory = runDirUnder(this.deps.storageRoot, stream);
    const copy = path.join(runDirectory, copyPath);
    return Effect.gen(function* () {
      const kept = yield* readOutputFile(copy).pipe(
        Effect.catchIf(meansAbsent, () => Effect.undefined),
      );
      if (kept === undefined) return undefined;
      const diff = unifiedDiffText(kept, accepted);
      yield* reportDiffTimeout(diff.timeout);
      return diff.text === undefined
        ? undefined
        : `[System: The user edited "${path.basename(file)}" from revision ${output.round + 1} of the document task you launched before accepting it into the workspace. Their changes to the task's output:\n\n\`\`\`diff\n${diff.text}\n\`\`\`]`;
    }).pipe(
      // The accept goes ahead without the note, and the miss is a warning.
      Effect.catch((error) =>
        Effect.logWarning(
          `Could not read what the user changed in ${file}: ${toErrorMessage(error)}`,
        ).pipe(withLogChannel(CHANNEL), Effect.as(undefined)),
      ),
    );
  }

  /** The run's newest output at `file`. In-place workflows reuse the same
   *  workspace path across rounds, so the first match would name an
   *  earlier round. */
  private latestOutput(stream: RunId, file: string) {
    return this.deps
      .rounds(stream)
      .flatMap((round) => round.outputs)
      .filter((info) => info.location.absolutePath === file)
      .toSorted((a, b) => b.round - a.round)
      .at(0);
  }
}

/**
 * An output file's text with CRLF line endings normalized. The path is an
 * absolute one the controller already resolved, so this reads through the
 * process filesystem rather than a rooted view that would refuse a path the
 * user picked outside the workspace.
 */
function readOutputFile(file: string) {
  return Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    readNormalizedFile(fs, file),
  );
}
