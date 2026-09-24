import path from 'node:path';

import { Data, Effect, FileSystem, type PlatformError } from 'effect';

import {
  getHelperModelName,
  validateRunRequest,
  type SessionHandle,
  type ValidatedRunRequest,
} from '@agent/runtime';
import { createLatexRunDiscovery } from '@agent/storage';
import { emitAppSignal } from '@eventBus/AppSignals';
import type { NotificationFailed, PromptFailed } from '@hosts/uiHosts';
import { acceptEditedFileReplace } from '@latex/acceptedFileTarget';
import { openFirstLabelMatch } from '@latex/labelSearch';
import { LaTeXdiffService } from '@latex/latexdiff';
import {
  latexdiffAllFailedMessage,
  NO_LATEXDIFF_OPERATIONS_MESSAGE,
} from '@latex/latexdiff/latexdiffCopy';
import { runLatexdiffForRun } from '@latex/latexdiff/runLatexdiff';
import type {
  DiffProgressReporter,
  DiffRunOutcome,
} from '@latex/latexdiff/types';
import type { StateStore, StateReadFailed } from '@platform/interfaces';
import {
  type ProcessRuntime,
  type ProcessServices,
  withProcessServices,
} from '@platform/processRuntime';
import type { LatexdiffMathMarkupValue } from '@shared/constants/latexConfig';
import type { OutputFileInfo, ReadonlyRoundIndexed } from '@shared/schemas';
import type { Rejected } from '@shared/session/requestErrors';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  pathToLocationIn,
} from '@utils/files/fileLocation';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';

const DESKTOP_LATEXDIFF_CHANNEL = 'DesktopProgressFileActions';

/**
 * The diff window would not open. The desktop's diff surface fails with what
 * it hit — a side that would not read, a patch the OS editor refused — and the
 * file-actions port takes tags, never a bare value, so the compare action
 * words that failure as this one.
 */
class DiffViewUnavailable extends Data.TaggedError('DiffViewUnavailable')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type DesktopProgressFileActionUi = Pick<
  DesktopAgentRunHost,
  | 'openPath'
  | 'openBuildDisplay'
  | 'openDiff'
  | 'confirmAcceptFile'
  | 'showInfoMessage'
> & {
  /**
   * The error notice, which this surface answers by refusing the request:
   * unlike the {@link DesktopAgentRunHost} member it sits beside, its failure
   * channel carries the request's own `Rejected`, so the caller rethrows the
   * refusal exactly as the rejecting promise did.
   */
  showErrorMessage(message: string): Effect.Effect<void, Rejected>;
};

/**
 * Bridge-owned capabilities the file actions reach back into: starting a fresh
 * agent run (merge) and enumerating workspace input/context files (label
 * search). Kept as a narrow interface so the actions stay decoupled from the
 * full progress bridge.
 */
interface DesktopProgressFileActionHost {
  readonly session: SessionHandle;
  /** The process global state the window root holds; the merge run reads the
   *  helper model from it. */
  readonly globalState: StateStore;
  /** The process runtime the window root holds; the latexdiff programs and
   *  the file reads and writes below take their services from it. Nothing
   *  settles here: every member of this class is a program its caller runs. */
  readonly runtime: ProcessRuntime;
  startRun(request: ValidatedRunRequest): void;
  listWorkspaceCandidateFiles(): Effect.Effect<
    readonly string[],
    PlatformError.PlatformError,
    ProcessServices
  >;
}

export interface DesktopLatexdiffWorkspaceScan {
  agent: string;
  model: string;
  inputFile: string;
  /** Multi-document outputs to diff; defaults to `inputFile` when omitted. */
  outputFiles?: string[];
}

/** Read only by the members below; a caller builds one structurally. */
interface DesktopLatexdiffRunContext {
  outputsByRound: ReadonlyRoundIndexed<OutputFileInfo>;
  runId?: string;
  workspaceScan?: DesktopLatexdiffWorkspaceScan;
}

export class DesktopProgressFileActions {
  constructor(
    private readonly ui: DesktopProgressFileActionUi,
    private readonly host: DesktopProgressFileActionHost,
  ) {}

  compareFiles(
    baseFile: string,
    editedFile: string,
  ): Effect.Effect<void, DiffViewUnavailable> {
    return this.ui
      .openDiff(
        { filePath: baseFile },
        { filePath: editedFile },
        `Compare: ${path.basename(editedFile)} <-> ${path.basename(baseFile)}`,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DiffViewUnavailable({ message: toErrorMessage(cause), cause }),
        ),
      );
  }

  runMergeFile(
    baseFile: string,
    editedFile: string,
  ): Effect.Effect<void, Rejected | StateReadFailed> {
    return Effect.gen({ self: this }, function* () {
      const validation = validateRunRequest({
        config: {
          agent: 'merge',
          model: yield* getHelperModelName(this.host.globalState),
          inputFiles: [baseFile],
          editedFile,
        },
      });
      if (!validation.valid) {
        yield* this.ui.showErrorMessage(`Merge: ${validation.message}`);
        return;
      }
      this.host.startRun(validation.request);
    });
  }

  /**
   * The host-neutral accept sequence, as this bridge's own program: its reads
   * and writes are the sequence's, against the `FileSystem` the request that
   * yields it already carries, so nothing settles here.
   */
  acceptEditedFile(baseFile: string, editedFile: string) {
    return acceptEditedFileReplace<PromptFailed | NotificationFailed>(
      pathToLocationIn(this.host.session.roots.workspace, baseFile),
      pathToLocationIn(this.host.session.roots.workspace, editedFile),
      {
        confirm: (message) => this.ui.confirmAcceptFile(message),
        emitWritten: (absolutePath) =>
          emitAppSignal('workspaceFilesWritten', {
            absolutePaths: [absolutePath],
          }),
        showInfo: (message) => this.ui.showInfoMessage(message),
      },
    );
  }

  diffAcceptedFilePair(
    baseFile: string,
    editedFile: string,
    runContext: DesktopLatexdiffRunContext,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const outcome = yield* this.runSharedLatexdiff(runContext);
      if (outcome && (yield* this.openSharedLatexdiffResults(outcome))) return;

      // No round-aware diff was produced (no rounds resolved, the shared core
      // failed, or every operation failed) — fall back to a single-file diff
      // so the user still gets a comparison.
      yield* this.runLatexdiffFile(baseFile, editedFile);
    });
  }

  /**
   * Stream-toolbar "diff" action: run the round-aware latexdiff for a whole run
   * and open every diff it produced.
   *
   * This is the counterpart of `diffAcceptedFilePair`, which exists to diff one
   * accepted file pair and therefore has a single-file fallback. Here there is
   * no such pair to fall back to — the request is scoped to a run — so an empty
   * or failed outcome reports instead, matching what the VS Code command shows
   * when a run yields no diff operations. This host has no quick-pick to
   * choose a markup mode with, so every desktop diff runs with the configured
   * `texra.latexdiff.mathMarkup`.
   */
  diffStreamToolbarAction(
    runContext: DesktopLatexdiffRunContext,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const outcome = yield* this.runSharedLatexdiff(runContext);
      if (!outcome?.results.length) {
        yield* this.ui.showInfoMessage(NO_LATEXDIFF_OPERATIONS_MESSAGE);
        return;
      }

      if (yield* this.openSharedLatexdiffResults(outcome)) return;

      yield* this.ui.showErrorMessage(
        latexdiffAllFailedMessage(
          yield* readSettingFrom<LatexdiffMathMarkupValue>(
            this.host.session.roots,
            WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
          ),
        ),
      );
    });
  }

  runLatexdiffFile(
    baseFile: string,
    editedFile: string,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const service = new LaTeXdiffService(
        DESKTOP_LATEXDIFF_CHANNEL,
        this.host.session.roots,
      );
      const result = yield* service.runDiff(
        pathToLocationIn(this.host.session.roots.workspace, baseFile),
        pathToLocationIn(this.host.session.roots.workspace, editedFile),
        '_diff',
        undefined,
        { cwd: this.host.session.roots.workspace },
      );

      if (!result.success) {
        yield* this.ui.showErrorMessage(result.message);
        return;
      }

      yield* this.openDiffOutput(result.diffPath);
    }).pipe((program) => withProcessServices(this.host.runtime, program));
  }

  findAndOpenLabel(label: string): Effect.Effect<boolean, Error> {
    return withProcessServices(
      this.host.runtime,
      Effect.gen({ self: this }, function* () {
        const candidates = new Set(
          yield* this.host.listWorkspaceCandidateFiles(),
        );
        const fs = yield* FileSystem.FileSystem;
        return yield* openFirstLabelMatch(
          label,
          candidates,
          (file) => fs.readFileString(file),
          (file) => this.ui.openPath(file),
        );
      }),
    );
  }

  private runSharedLatexdiff(
    runContext: DesktopLatexdiffRunContext,
  ): Effect.Effect<DiffRunOutcome | undefined> {
    return Effect.suspend(() => {
      const scan = runContext.workspaceScan;
      const hasOutputs = Object.keys(runContext.outputsByRound).length > 0;
      // Nothing to diff without either pre-resolved rounds or a scan identity.
      if (!hasOutputs && !scan) return Effect.succeed(undefined);

      // Delegate the resolve + dispatch policy (caller metadata → run-id scan →
      // auto-discovery) to the single host-neutral core shared
      // with the VS Code command and the CLI, instead of re-implementing it here.
      // Desktop has no per-operation progress UI.
      const progress: DiffProgressReporter = { report: () => undefined };
      return runLatexdiffForRun({
        agent: scan?.agent ?? '',
        model: scan?.model ?? '',
        inputFile: scan?.inputFile ?? '',
        workspaceRoot: this.host.session.roots.workspace,
        storageRoot: this.host.session.roots.storage,
        outputFiles: scan?.outputFiles,
        runId: runContext.runId ?? null,
        outputsByRound: hasOutputs ? runContext.outputsByRound : null,
        generateBetweenRoundDiffs: true,
        runDiscovery: createLatexRunDiscovery(this.host.session),
        latexdiff: {
          channel: DESKTOP_LATEXDIFF_CHANNEL,
          service: new LaTeXdiffService(
            DESKTOP_LATEXDIFF_CHANNEL,
            this.host.session.roots,
          ),
        },
        progress,
      }).pipe(
        Effect.map((executed) => executed.outcome),
        // The core can fail (e.g. no workspace path). Don't abort the whole
        // action — answer undefined so the caller falls back to single-file —
        // but log the cause so a systematic round-aware failure isn't silently
        // downgraded to single-file diffs with no trace. An interrupt (the
        // runtime disposing at shutdown) is not a diff failure to fall back
        // from: it is not a failure of this channel, so it travels on and the
        // request settles as interrupted instead of scheduling more diff work
        // on a closing window.
        Effect.catch((error) =>
          Effect.sync(() => {
            console.error(
              `Round-aware LaTeX diff failed; falling back to single-file diff: ${toErrorMessage(
                error,
              )}`,
            );
            return undefined;
          }),
        ),
      );
    }).pipe((program) => withProcessServices(this.host.runtime, program));
  }

  /**
   * Open every successful diff (between-round runs produce many), mirroring the
   * VS Code command. Answers whether at least one diff was opened, so the
   * caller can fall back to a single-file diff when none were.
   */
  private openSharedLatexdiffResults(
    outcome: DiffRunOutcome,
  ): Effect.Effect<boolean, Error> {
    return Effect.gen({ self: this }, function* () {
      const successes = outcome.results.filter((entry) => entry.success);

      for (const result of successes) {
        yield* this.openDiffOutput(result.diffPath);
      }

      return successes.length > 0;
    });
  }

  /** Open a generated diff file via the desktop LaTeX build display. */
  private openDiffOutput(diffFilePath: string): Effect.Effect<void, Error> {
    return withProcessServices(
      this.host.runtime,
      this.ui.openBuildDisplay(createExternalLocation(diffFilePath)),
    );
  }
}
