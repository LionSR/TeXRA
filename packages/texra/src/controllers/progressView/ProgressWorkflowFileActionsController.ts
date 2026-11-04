// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports
import { withLogChannel } from '@texra-ai/harness/host';
import { RunFileService } from '@texra-ai/harness/plugins';
import { entryTypeIn } from '@texra-ai/harness/node';
import { toErrorMessage, type RunId } from '@texra-ai/harness/schemas';
import { Rejected, type HostRequestFailure } from '@texra-ai/harness';
import type { HostRequest } from '@texra/shared/session/hostRequest';
import { type AcceptCopyMeta } from '@texra/shared/plugins/documentOutputs';
import type { AppSignals } from '@texra-ai/harness/host';
import type { AgentConfig } from '@texra-ai/harness/schemas';
import type { HostRunActions } from '../session/hostRunActions';

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
  FileSystem.FileSystem | AppSignals
>;

interface ProgressWorkflowFileActionsHost {
  compareFiles(baseFile: string, editedFile: string): FileAction<void>;
  acceptEditedFile(
    baseFile: string,
    editedFile: string,
    copyMeta?: AcceptCopyMeta,
  ): FileAction<boolean | void>;
  latexdiffFile(baseFile: string, editedFile: string): FileAction<void>;
  openDirectory(directory: string): FileAction<void>;
  showInfo(message: string): FileAction<void>;
}

interface ProgressWorkflowFileActionsControllerDeps {
  state: HostRunActions['runOutputs'];
  host: ProgressWorkflowFileActionsHost;
  /** Storage root of the session whose runs this controller acts on. */
  storageRoot: string;
  /** The window's run actions this controller starts. */
  runs: Pick<HostRunActions, 'merge'>;
}

export class ProgressWorkflowFileActionsController {
  private readonly deps: ProgressWorkflowFileActionsControllerDeps;
  constructor(deps: ProgressWorkflowFileActionsControllerDeps) {
    this.deps = deps;
  }

  /** Apply an output-file request from either GUI host. */
  handle(
    request: Extract<HostRequest, { kind: 'fileAction' }>,
    config: AgentConfig | undefined,
  ): FileAction<void> {
    const base = request.base ?? undefined;
    switch (request.action) {
      case 'compareOriginal':
        return this.compareOriginal(request.file, base);
      case 'comparePrevious':
        return this.comparePrevious(request.file, request.prev ?? undefined);
      case 'accept':
        return this.acceptFile(request.file, base, request.runId, config);
      case 'merge':
        return this.mergeFile(request.file, base);
      case 'latexdiff':
        return this.latexdiffFile(request.file, base);
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
      (targetFile, baseFile) =>
        this.deps.host.compareFiles(baseFile, targetFile),
    ).pipe(Effect.asVoid);
  }

  comparePrevious(file: string, previous?: string): FileAction<void> {
    if (!previous) {
      return this.deps.host.showInfo('Compare previous needs a base file.');
    }

    return this.deps.host.compareFiles(previous, file);
  }

  acceptFile(
    file: string,
    base?: string,
    activeRun?: RunId,
    config?: AgentConfig,
  ): FileAction<void> {
    const copyMeta =
      activeRun && file
        ? this.buildCopyMeta(activeRun, file, config)
        : undefined;
    return this.executeWithBaseFile(
      file,
      base,
      'Accept',
      (targetFile, baseFile) =>
        this.deps.host.acceptEditedFile(baseFile, targetFile, copyMeta),
    ).pipe(Effect.asVoid);
  }

  mergeFile(file: string, base?: string): FileAction<void> {
    return this.executeWithBaseFile(
      file,
      base,
      'Merge',
      (targetFile, baseFile) => this.deps.runs.merge(baseFile, targetFile),
    ).pipe(Effect.asVoid);
  }

  latexdiffFile(file: string, base?: string): FileAction<void> {
    return this.executeWithBaseFile(
      file,
      base,
      'Latexdiff',
      (targetFile, baseFile) =>
        this.deps.host.latexdiffFile(baseFile, targetFile),
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

  /** Resolve the agent/model/round for an output file so "Accept" can offer
   *  a postfixed copy. Returns undefined when the run's agent/model or the
   *  file's round can't be determined (the quick-pick then just replaces). */
  private buildCopyMeta(
    stream: RunId,
    file: string,
    config: AgentConfig | undefined,
  ): AcceptCopyMeta | undefined {
    if (!config) return undefined;

    // Use the matched entry's own `round` and prefer the most recent match:
    // in-place workflows reuse the same workspace path across rounds, so the
    // Map key (and the first match) would mislabel the `r<round>` postfix.
    const rounds = Object.values(this.deps.state.getOutputFiles(stream))
      .flat()
      .filter((info) => info.location.absolutePath === file)
      .map((info) => info.round);
    if (rounds.length === 0) return undefined;

    return {
      agent: config.agent,
      model: config.model,
      round: Math.max(...rounds),
    };
  }
}
