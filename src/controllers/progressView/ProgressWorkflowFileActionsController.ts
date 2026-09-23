// Node imports
import path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { AgentResume } from '@platform/interfaces';
import type { AcceptCopyMeta, RunId } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import type { HostRequestFailure } from '@shared/session/requestErrors';
import {
  ensureRunDirUnder,
  findRunDirUnder,
  runDirUnder,
} from '@utils/files/runStorageFs';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { RunOutputsSource } from './runOutputs';

const CHANNEL = 'ProgressWorkflowFileActions';

type ProgressWorkflowFileActionsState = RunOutputsSource;

/**
 * What a file action runs on: the process `FileSystem` its run-storage reads
 * take, and the resume port the accepted-edit follow-up is delivered through.
 * Both hosts' request dispatchers already carry them, so an action is
 * `yield*`ed there rather than settled here.
 */
type FileActionServices = FileSystem.FileSystem | AgentResume;

/**
 * One file action. Its failure channel is the host's own vocabulary: every
 * host answers a request with a tag ({@link HostRequestFailure}), so a
 * refusal a host already worded — the desktop error notice is one — travels
 * as itself and no arm re-enters a runtime to settle this.
 */
type FileAction<A> = Effect.Effect<A, HostRequestFailure, FileActionServices>;

interface ProgressWorkflowFileActionsHost {
  compareFiles(baseFile: string, editedFile: string): FileAction<void>;
  acceptEditedFile(
    baseFile: string,
    editedFile: string,
    copyMeta?: AcceptCopyMeta,
  ): FileAction<boolean | void>;
  mergeFile(baseFile: string, editedFile: string): FileAction<void>;
  latexdiffFile(baseFile: string, editedFile: string): FileAction<void>;
  openDirectory(directory: string): FileAction<void>;
  readFile(file: string): FileAction<string>;
  showInfo(message: string): FileAction<void>;
  showError(message: string): FileAction<void>;
}

interface ProgressWorkflowFileActionsControllerDeps {
  state: ProgressWorkflowFileActionsState;
  host: ProgressWorkflowFileActionsHost;
  /** Storage root of the session whose runs this controller acts on. */
  storageRoot: string;
  sendFollowUp(
    stream: RunId,
    text: string,
  ): Effect.Effect<void, never, AgentResume>;
}

export class ProgressWorkflowFileActionsController {
  /** Per-stream snapshot of each output file's content at compare time. */
  private readonly modelOutputBackups = new Map<RunId, Map<string, string>>();

  constructor(
    private readonly deps: ProgressWorkflowFileActionsControllerDeps,
  ) {}

  /** Apply an output-file request from either GUI host. */
  handle(
    request: Extract<HostRequest, { kind: 'fileAction' }>,
    config: AgentConfig | undefined,
  ): FileAction<void> {
    const base = request.base ?? undefined;
    switch (request.action) {
      case 'compareOriginal':
        return this.compareOriginal(request.file, base, request.runId);
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

  openRunStorage(runId: RunId): FileAction<void> {
    return Effect.gen({ self: this }, function* () {
      const storageRoot = this.deps.storageRoot;
      let directoryToReveal = yield* findRunDirUnder(storageRoot, runId);
      if (!directoryToReveal) {
        yield* ensureRunDirUnder(storageRoot, runId);
        directoryToReveal = runDirUnder(storageRoot, runId);
      }
      yield* this.deps.host.openDirectory(directoryToReveal);
    }).pipe(
      Effect.catch((error) =>
        Effect.logError('Failed to open run folder', error).pipe(
          withLogChannel(CHANNEL),
          Effect.andThen(
            this.deps.host.showError(
              `Failed to open run folder: ${toErrorMessage(error)}`,
            ),
          ),
        ),
      ),
    );
  }

  /** `stream` is the run the file belongs to: it keys the compare-time
   *  backup that a later Accept reads. */
  compareOriginal(
    file: string,
    base?: string,
    stream?: RunId,
  ): FileAction<void> {
    return this.executeWithBaseFile(
      file,
      base,
      'Compare original',
      (targetFile, baseFile) =>
        Effect.gen({ self: this }, function* () {
          if (stream !== undefined) yield* this.backupModelOutput(stream, file);
          yield* this.deps.host.compareFiles(baseFile, targetFile);
        }),
    ).pipe(Effect.asVoid);
  }

  comparePrevious(
    file: string,
    base?: string,
    previous?: string,
  ): FileAction<void> {
    const previousFile = previous ?? base;
    if (!previousFile) {
      return this.deps.host.showInfo('Compare previous needs a base file.');
    }

    return this.deps.host.compareFiles(previousFile, file);
  }

  acceptFile(
    file: string,
    base?: string,
    activeRun?: RunId,
    config?: AgentConfig,
  ): FileAction<void> {
    return Effect.gen({ self: this }, function* () {
      const backup =
        file && activeRun
          ? this.modelOutputBackups.get(activeRun)?.get(file)
          : undefined;
      let currentContent: string | undefined;

      if (backup !== undefined) {
        currentContent = yield* this.deps.host
          .readFile(file)
          .pipe(
            Effect.catch((error) =>
              Effect.logDebug(
                `Could not read current content of ${file} before accept`,
              ).pipe(
                Effect.annotateLogs({ data: error }),
                withLogChannel(CHANNEL),
                Effect.as(undefined),
              ),
            ),
          );
      }

      let copyMeta: AcceptCopyMeta | undefined;
      if (activeRun && file) {
        copyMeta = this.buildCopyMeta(activeRun, file, config);
      }

      const accepted = yield* this.executeWithBaseFile(
        file,
        base,
        'Accept',
        (targetFile, baseFile) =>
          this.deps.host.acceptEditedFile(baseFile, targetFile, copyMeta),
      );
      if (!accepted) return;

      if (
        activeRun !== undefined &&
        backup !== undefined &&
        currentContent !== undefined &&
        currentContent !== backup
      ) {
        const fileName = path.basename(file);
        yield* this.deps.sendFollowUp(
          activeRun,
          `[System: User modified the model's suggested output for "${fileName}" before accepting. The accepted version differs from the original model output.]`,
        );
      }

      if (backup !== undefined && activeRun) {
        const runBackups = this.modelOutputBackups.get(activeRun);
        runBackups?.delete(file);
        if (runBackups?.size === 0) {
          this.modelOutputBackups.delete(activeRun);
        }
      }
    });
  }

  mergeFile(file: string, base?: string): FileAction<void> {
    return this.executeWithBaseFile(
      file,
      base,
      'Merge',
      (targetFile, baseFile) => this.deps.host.mergeFile(baseFile, targetFile),
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

  private backupModelOutput(runId: RunId, file: string): FileAction<void> {
    if (!file) return Effect.void;

    return Effect.gen({ self: this }, function* () {
      const content = yield* this.deps.host.readFile(file);
      const runBackups =
        this.modelOutputBackups.get(runId) ?? new Map<string, string>();
      runBackups.set(file, content);
      this.modelOutputBackups.set(runId, runBackups);
    }).pipe(
      // Best-effort: backup only informs the accepted-edit follow-up, but a
      // later Accept then has no compare-time content to offer.
      Effect.catch((error) =>
        Effect.logDebug(`Could not back up model output for ${file}`).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
        ),
      ),
    );
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
