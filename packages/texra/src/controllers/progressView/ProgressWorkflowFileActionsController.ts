// Node imports
import path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Option } from 'effect';

// Local imports
import {
  pathToLocationIn,
  reportDiffTimeout,
  unifiedDiffText,
  withLogChannel,
} from '@texra-ai/harness/host';
import { acceptEditedFileReplace } from '@latex/acceptedFileTarget';
import { RunFileService } from '@texra-ai/harness/plugins';
import { absentReason, entryTypeIn } from '@texra-ai/harness/node';
import { toErrorMessage, type RunId } from '@texra-ai/harness/schemas';
import { Rejected } from '@texra-ai/harness';
import type { HostRequest } from '@texra/shared/session/hostRequest';
import { revisionLayout } from '@texra/shared/constants/revisionLayout';
import type { AppSignals, ProcessServices } from '@texra-ai/harness/host';
import type { HostRunActions } from '../session/hostRunActions';
import type { RoundOutput } from '@texra/shared/plugins/documentOutputs';
import { type HostRequestFailure } from '@texra/controllers/session/hostCallFailure';

const CHANNEL = 'ProgressWorkflowFileActions';

/**
 * One file action. Its failure channel is the host's own vocabulary: every
 * host answers a request with a tag ({@link HostRequestFailure}), so a
 * refusal a host already worded — the desktop error notice is one — travels
 * as itself and no case re-enters a runtime to finish this. It runs on the
 * process `FileSystem` its run-storage reads take, and an accept announces
 * its write on the process's signal hub; both hosts' request dispatchers
 * already carry them, so it is `yield*`ed there, not finished here.
 */
type FileAction<A> = Effect.Effect<
  A,
  HostRequestFailure,
  FileSystem.FileSystem | AppSignals | ProcessServices
>;

type FileActionRequest = Extract<HostRequest, { kind: 'fileAction' }>;

/** The workflow toolbar's file verbs a host performs. */
export interface ProgressWorkflowFileActionsHost {
  /** Show `editedFile` against `baseFile` in the host's diff view. */
  openDiff(
    baseFile: string,
    editedFile: string,
    title: string,
  ): FileAction<void>;
  /** Ask to write an accepted file; false when the user declines. */
  confirmAccept(message: string): Effect.Effect<boolean, HostRequestFailure>;
  openDirectory(directory: string): FileAction<void>;
  showInfo(message: string): Effect.Effect<void, HostRequestFailure>;
}

interface ProgressWorkflowFileActionsControllerDeps {
  /** A run's rounds, as the session view holds its documents fact. */
  rounds: (runId: RunId) => readonly RoundOutput[];
  host: ProgressWorkflowFileActionsHost;
  /** Storage root of the session whose runs this controller acts on. */
  storageRoot: string;
  /** The window's workspace, which an accepted file's location is in. */
  workspace: string | undefined;
  /** The window's run actions this controller starts or follows up. */
  runs: Pick<HostRunActions, 'merge' | 'followUpLauncher'>;
}

export class ProgressWorkflowFileActionsController {
  private readonly deps: ProgressWorkflowFileActionsControllerDeps;
  constructor(deps: ProgressWorkflowFileActionsControllerDeps) {
    this.deps = deps;
  }

  /** Apply an output-file request from either GUI host; its latexdiff is
   *  the window's latexdiff verb (`latexdiffVerbs`). */
  handle(
    request: FileActionRequest & {
      action: Exclude<FileActionRequest['action'], 'latexdiff'>;
    },
  ): FileAction<void> {
    const base = request.base ?? undefined;
    switch (request.action) {
      case 'compareOriginal':
        return this.compareOriginal(request.file, base);
      case 'comparePrevious':
        return this.comparePrevious(request.file, request.prev ?? undefined);
      case 'accept':
        return this.acceptFile(request.file, base, request.runId);
      case 'merge':
        return this.mergeFile(request.file, base);
    }
  }

  readonly openRunStorage: (runId: RunId) => FileAction<void> = Effect.fn(
    'ProgressWorkflowFileActionsController.openRunStorage',
  )(
    { self: this },
    function* (runId: RunId) {
      const { runDirectory } = new RunFileService(runId, {
        storage: this.deps.storageRoot,
        workspace: undefined,
      });
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

  compareOriginal(file: string, base?: string): FileAction<void> {
    return this.executeWithBaseFile(
      file,
      base,
      'Compare original',
      (targetFile, baseFile) => this.compare(baseFile, targetFile),
    ).pipe(Effect.asVoid);
  }

  /** The diff of `edited` against `base`, titled the same on every host. */
  private compare(base: string, edited: string): FileAction<void> {
    return this.deps.host.openDiff(
      base,
      edited,
      `Compare: ${path.basename(edited)} ↔ ${path.basename(base)}`,
    );
  }

  comparePrevious(file: string, previous?: string): FileAction<void> {
    if (!previous) {
      return this.deps.host.showInfo('Compare previous needs a base file.');
    }

    return this.compare(previous, file);
  }

  readonly acceptFile: (
    file: string,
    base?: string,
    activeRun?: RunId,
  ) => FileAction<void> = Effect.fn(
    'ProgressWorkflowFileActionsController.acceptFile',
  )({ self: this }, function* (file: string, base?: string, activeRun?: RunId) {
    if (!base)
      return yield* this.deps.host.showInfo('Accept needs a base file.');
    const { host, workspace } = this.deps;
    // The content the accept wrote, read once by the write itself, so the
    // diff the launching chat is told of is exactly what was accepted.
    const written = yield* acceptEditedFileReplace(
      pathToLocationIn(workspace, base),
      pathToLocationIn(workspace, file),
      { confirm: host.confirmAccept, showInfo: host.showInfo },
    );
    if (Option.isNone(written) || !activeRun) return;
    const edit = yield* this.userEdit(activeRun, file, written.value);
    if (edit !== undefined)
      yield* this.deps.runs.followUpLauncher(activeRun, edit);
  });

  mergeFile(file: string, base?: string): FileAction<void> {
    return this.executeWithBaseFile(
      file,
      base,
      'Merge',
      (targetFile, baseFile) => this.deps.runs.merge(baseFile, targetFile),
    ).pipe(Effect.asVoid);
  }

  private executeWithBaseFile(
    file: string,
    base: string | undefined,
    actionName: string,
    execute: (file: string, base: string) => FileAction<boolean | void>,
  ): FileAction<boolean> {
    if (!base) {
      return this.deps.host
        .showInfo(`${actionName} needs a base file.`)
        .pipe(Effect.as(false));
    }
    return execute(file, base).pipe(Effect.map((result) => result !== false));
  }

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
    if (output === undefined || copyPath === undefined)
      return Effect.succeed(undefined);
    const { runDirectory } = new RunFileService(stream, {
      storage: this.deps.storageRoot,
      workspace: undefined,
    });
    const copy = path.join(runDirectory, copyPath);
    return Effect.gen(function* () {
      const kept = yield* readOutputFile(copy).pipe(
        Effect.catchIf(absentReason, () => Effect.succeed(undefined)),
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
    Effect.map(fs.readFileString(file), (text) =>
      text.replaceAll('\r\n', '\n'),
    ),
  );
}
