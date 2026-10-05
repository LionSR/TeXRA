import path from 'node:path';

import { Data, Effect, FileSystem, type PlatformError } from 'effect';

import {
  getHelperModelName,
  validateRunRequest,
  type SessionHandle,
  type ValidatedRunRequest,
} from '@agent/runtime';
import { emitAppSignal } from '@eventBus/AppSignals';
import { acceptEditedFileReplace } from '@latex/acceptedFileTarget';
import { openFirstLabelMatch } from '@latex/labelSearch';
import { LaTeXdiffService } from '@latex/latexdiff';
import {
  latexdiffAllFailedMessage,
  NO_LATEXDIFF_OPERATIONS_MESSAGE,
} from '@latex/latexdiff/latexdiffCopy';
import { runLatexdiffForRun } from '@latex/latexdiff/diffOperations';
import type { DiffRunOutcome } from '@latex/latexdiff/types';
import {
  type ProcessRuntime,
  type ProcessServices,
  withProcessServices,
} from '@platform/processRuntime';
import type { NotificationFailed, PromptFailed } from '@texra/hosts/uiHosts';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';
import type { LatexdiffMathMarkupValue } from '@texra/shared/constants/latexConfig';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import { runOutputReader } from '@texra/tools/documents/runOutputs';
import { readSettingFrom } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  pathToLocationIn,
} from '@utils/files/fileLocation';
import type { Rejected, StateReadFailed } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';
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
        config: documentTaskConfig({
          agent: 'merge',
          model: yield* getHelperModelName(this.host.session.roots),
          inputFiles: [baseFile],
          editedFile,
        }),
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

  /**
   * Stream-toolbar "diff" action: run the round-aware latexdiff for a whole run
   * and open every diff it produced.
   *
   * An empty outcome reports instead, matching what the VS Code command shows
   * when a run yields no diff operations; a failure of the core itself travels
   * on to the caller. This host has no quick-pick to choose a markup mode
   * with, so every desktop diff runs with the configured
   * `texra.latexdiff.mathMarkup`.
   */
  diffStreamToolbarAction(runId: RunId): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      // The single host-neutral core shared with the VS Code command.
      // Desktop has no per-operation progress UI.
      const outcome = yield* withProcessServices(
        this.host.runtime,
        runLatexdiffForRun({
          runId,
          roots: this.host.session.roots,
          runDiscovery: runOutputReader(this.host.session),
          channel: DESKTOP_LATEXDIFF_CHANNEL,
          progress: { report: () => undefined },
        }),
      );
      if (!outcome.results.length) {
        yield* this.ui.showInfoMessage(NO_LATEXDIFF_OPERATIONS_MESSAGE);
        return;
      }

      if (yield* this.openSharedLatexdiffResults(outcome)) return;

      yield* this.ui.showErrorMessage(
        latexdiffAllFailedMessage(
          yield* readSettingFrom<LatexdiffMathMarkupValue>(
            this.host.session.roots,
            DocumentsStateKey.LATEXDIFF_MATH_MARKUP,
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

  /**
   * Open every successful diff (between-round runs produce many), mirroring the
   * VS Code command. Answers whether at least one diff was opened, so the
   * caller can report when none were.
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
