import path from 'node:path';

import { Cause, Effect, Exit, FileSystem } from 'effect';

import {
  getHelperModelName,
  validateRunRequest,
  type SessionHandle,
  type ValidatedRunRequest,
} from '@agent/runtime';
import { createLatexRunDiscovery } from '@agent/storage';
import { appSignals } from '@eventBus/AppSignals';
import { acceptEditedFileReplace } from '@latex/acceptedFileTarget';
import { openFirstLabelMatch } from '@latex/labelSearch';
import { LaTeXdiffService } from '@latex/latexdiff';
import {
  latexdiffAllFailedMessage,
  NO_LATEXDIFF_OPERATIONS_MESSAGE,
} from '@latex/latexdiff/latexdiffCopy';
import { DEFAULT_MATH_MARKUP } from '@latex/latexdiff/mathMarkup';
import { runLatexdiffForRun } from '@latex/latexdiff/runLatexdiff';
import type {
  DiffProgressReporter,
  DiffRunOutcome,
} from '@latex/latexdiff/types';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import type { OutputFileInfo, ReadonlyRoundIndexed } from '@shared/schemas';
import type { Rejected } from '@shared/session/requestErrors';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  pathToLocationIn,
} from '@utils/files/fileLocation';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';

const DESKTOP_LATEXDIFF_CHANNEL = 'DesktopProgressFileActions';

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
   *  the file reads and writes below settle on it. */
  readonly runtime: ProcessRuntime;
  startRun(request: ValidatedRunRequest): void;
  listWorkspaceCandidateFiles(): Promise<string[]>;
}

export interface DesktopLatexdiffWorkspaceScan {
  agent: string;
  model: string;
  inputFile: string;
  /** Multi-document outputs to diff; defaults to `inputFile` when omitted. */
  outputFiles?: string[];
}

export interface DesktopLatexdiffRunContext {
  outputsByRound: ReadonlyRoundIndexed<OutputFileInfo>;
  runId?: string;
  workspaceScan?: DesktopLatexdiffWorkspaceScan;
}

export class DesktopProgressFileActions {
  constructor(
    private readonly ui: DesktopProgressFileActionUi,
    private readonly host: DesktopProgressFileActionHost,
  ) {}

  async compareFiles(baseFile: string, editedFile: string): Promise<void> {
    await this.ui.openDiff(
      { filePath: baseFile },
      { filePath: editedFile },
      `Compare: ${path.basename(editedFile)} <-> ${path.basename(baseFile)}`,
    );
  }

  async runMergeFile(baseFile: string, editedFile: string): Promise<void> {
    const validation = validateRunRequest({
      config: {
        agent: 'merge',
        model: getHelperModelName(this.host.globalState),
        inputFiles: [baseFile],
        editedFile,
      },
    });
    if (!validation.valid) {
      await this.host.runtime.runPromise(
        this.ui.showErrorMessage(`Merge: ${validation.message}`),
      );
      return;
    }
    this.host.startRun(validation.request);
  }

  /**
   * The bridge's Promise face over the host-neutral accept sequence: its reads
   * and writes are the sequence's own, against the `FileSystem` the window's
   * runtime carries, so this settles the whole program in one place.
   */
  acceptEditedFile(baseFile: string, editedFile: string): Promise<boolean> {
    return this.host.runtime.runPromise(
      acceptEditedFileReplace(
        pathToLocationIn(this.host.session.roots.workspace, baseFile),
        pathToLocationIn(this.host.session.roots.workspace, editedFile),
        {
          confirm: (message) =>
            Effect.promise(() => this.ui.confirmAcceptFile(message)),
          emitWritten: (absolutePath) =>
            appSignals.emit('workspaceFilesWritten', {
              absolutePaths: [absolutePath],
            }),
          showInfo: (message) => this.ui.showInfoMessage(message),
        },
      ),
    );
  }

  async diffAcceptedFilePair(
    baseFile: string,
    editedFile: string,
    runContext: DesktopLatexdiffRunContext,
  ): Promise<void> {
    const outcome = await this.runSharedLatexdiff(runContext);
    if (outcome && (await this.openSharedLatexdiffResults(outcome))) return;

    // No round-aware diff was produced (no rounds resolved, the shared core
    // threw, or every operation failed) — fall back to a single-file diff so
    // the user still gets a comparison.
    await this.runLatexdiffFile(baseFile, editedFile);
  }

  /**
   * Stream-toolbar "diff" action: run the round-aware latexdiff for a whole run
   * and open every diff it produced.
   *
   * This is the counterpart of `diffAcceptedFilePair`, which exists to diff one
   * accepted file pair and therefore has a single-file fallback. Here there is
   * no such pair to fall back to — the request is scoped to a run — so an empty
   * or failed outcome reports instead, matching what the VS Code command shows
   * when a run yields no diff operations. Like the rest of the desktop
   * latexdiff surface it uses `DEFAULT_MATH_MARKUP`, since this host has no
   * quick-pick to choose a markup mode with.
   */
  async diffStreamToolbarAction(
    runContext: DesktopLatexdiffRunContext,
  ): Promise<void> {
    const outcome = await this.runSharedLatexdiff(runContext);
    if (!outcome?.results.length) {
      await this.host.runtime.runPromise(
        this.ui.showInfoMessage(NO_LATEXDIFF_OPERATIONS_MESSAGE),
      );
      return;
    }

    if (await this.openSharedLatexdiffResults(outcome)) return;

    await this.host.runtime.runPromise(
      this.ui.showErrorMessage(latexdiffAllFailedMessage(DEFAULT_MATH_MARKUP)),
    );
  }

  async runLatexdiffFile(baseFile: string, editedFile: string): Promise<void> {
    const service = new LaTeXdiffService(DESKTOP_LATEXDIFF_CHANNEL);
    const result = await this.host.runtime.runPromise(
      service.runDiff(
        pathToLocationIn(this.host.session.roots.workspace, baseFile),
        pathToLocationIn(this.host.session.roots.workspace, editedFile),
        '_diff',
        DEFAULT_MATH_MARKUP,
      ),
    );

    if (!result.success) {
      await this.host.runtime.runPromise(
        this.ui.showErrorMessage(result.message),
      );
      return;
    }

    await this.openDiffOutput(result.diffPath);
  }

  async findAndOpenLabel(label: string): Promise<boolean> {
    const { runtime } = this.host;
    const candidates = new Set(await this.host.listWorkspaceCandidateFiles());
    const fs = await runtime.runPromise(Effect.service(FileSystem.FileSystem));
    return openFirstLabelMatch(
      label,
      candidates,
      (file) => runtime.runPromise(fs.readFileString(file)),
      (file) => runtime.runPromise(this.ui.openPath(file)),
    );
  }

  private async runSharedLatexdiff(
    runContext: DesktopLatexdiffRunContext,
  ): Promise<DiffRunOutcome | undefined> {
    const scan = runContext.workspaceScan;
    const hasOutputs = Object.keys(runContext.outputsByRound).length > 0;
    // Nothing to diff without either pre-resolved rounds or a scan identity.
    if (!hasOutputs && !scan) return undefined;

    // Delegate the resolve + dispatch policy (caller metadata → run-id scan →
    // auto-discovery) to the single host-neutral core shared
    // with the VS Code command and the CLI, instead of re-implementing it here.
    // Desktop has no per-operation progress UI.
    const progress: DiffProgressReporter = { report: () => undefined };
    const settled = await this.host.runtime.runPromiseExit(
      runLatexdiffForRun({
        filesystem: nodeFilesystem,
        agent: scan?.agent ?? '',
        model: scan?.model ?? '',
        inputFile: scan?.inputFile ?? '',
        workspaceRoot: this.host.session.roots.workspace,
        outputFiles: scan?.outputFiles,
        runId: runContext.runId ?? null,
        outputsByRound: hasOutputs ? runContext.outputsByRound : null,
        mathMarkup: DEFAULT_MATH_MARKUP,
        generateBetweenRoundDiffs: true,
        runDiscovery: createLatexRunDiscovery(this.host.session),
        latexdiff: {
          channel: DESKTOP_LATEXDIFF_CHANNEL,
          service: new LaTeXdiffService(DESKTOP_LATEXDIFF_CHANNEL),
        },
        progress,
      }),
    );
    if (Exit.isSuccess(settled)) return settled.value.outcome;
    // An interrupt (the runtime disposing at shutdown) is not a diff failure
    // to fall back from: rethrow it so the request settles as interrupted
    // instead of scheduling more diff work on a closing window.
    if (Cause.hasInterruptsOnly(settled.cause)) {
      throw Cause.squash(settled.cause);
    }
    // The core can fail (e.g. no workspace path). Don't abort the whole
    // action — return undefined so the caller falls back to single-file —
    // but log the cause so a systematic round-aware failure isn't silently
    // downgraded to single-file diffs with no trace.
    console.error(
      `Round-aware LaTeX diff failed; falling back to single-file diff: ${toErrorMessage(
        Cause.squash(settled.cause),
      )}`,
    );
    return undefined;
  }

  /**
   * Open every successful diff (between-round runs produce many), mirroring the
   * VS Code command. Returns whether at least one diff was opened, so the
   * caller can fall back to a single-file diff when none were.
   */
  private async openSharedLatexdiffResults(
    outcome: DiffRunOutcome,
  ): Promise<boolean> {
    const successes = outcome.results.filter((entry) => entry.success);

    for (const result of successes) {
      await this.openDiffOutput(result.diffPath);
    }

    return successes.length > 0;
  }

  /** Open a generated diff file via the desktop LaTeX build display. */
  private openDiffOutput(diffFilePath: string): Promise<void> {
    return this.ui.openBuildDisplay(createExternalLocation(diffFilePath));
  }
}
