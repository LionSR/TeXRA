import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ValidatedExecutionRequest } from '@agent/core/state/executionRequests';
import { acceptEditedFileReplace } from '@latex/acceptedFileTarget';
import { openFirstLabelMatch } from '@latex/labelSearch';
import { LaTeXdiffService } from '@latex/latexdiff';
import { DEFAULT_MATH_MARKUP } from '@latex/latexdiff/mathMarkup';
import { runLatexdiffForExecution } from '@latex/latexdiff/runLatexdiff';
import type {
  DiffProgressReporter,
  DiffRunOutcome,
  DiffRunResult,
} from '@latex/latexdiff/types';
import type { OutputFileInfo, RoundIndexed } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import {
  createExternalLocation,
  pathToLocation,
} from '@utils/files/fileLocation';
import type { DesktopAgentExecutionHost } from './desktopAgentExecutionHost.js';

const DESKTOP_LATEXDIFF_CHANNEL = 'DesktopProgressBridge';

type DesktopProgressFileActionUi = Pick<
  DesktopAgentExecutionHost,
  | 'openPath'
  | 'openBuildDisplay'
  | 'openDiff'
  | 'confirmAcceptFile'
  | 'showInfoMessage'
  | 'showErrorMessage'
>;

/**
 * Bridge-owned capabilities the file actions reach back into: starting a fresh
 * agent execution (merge) and enumerating workspace input/context files (label
 * search). Kept as a narrow interface so the actions stay decoupled from the
 * full progress bridge.
 */
export interface DesktopProgressFileActionHost {
  startExecution(request: ValidatedExecutionRequest): void;
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
  outputsByRound: RoundIndexed<OutputFileInfo>;
  executionId?: string;
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
    const [{ getHelperModelName }, { validateExecutionRequest }] =
      await Promise.all([
        import('@agent/runtime'),
        import('@agent/core/state/executionRequests'),
      ]);
    const validation = validateExecutionRequest({
      config: {
        agent: 'merge',
        model: getHelperModelName(),
        inputFiles: [baseFile],
        editedFile,
      },
    });
    if (!validation.valid) {
      await this.ui.showErrorMessage(`Merge: ${validation.message}`);
      return;
    }
    this.host.startExecution(validation.request);
  }

  async acceptEditedFile(
    baseFile: string,
    editedFile: string,
  ): Promise<boolean> {
    return acceptEditedFileReplace(
      pathToLocation(baseFile),
      pathToLocation(editedFile),
      {
        exists: (location) => AbsoluteFS.exists(location.absolutePath),
        readFile: (location) => readFile(location.absolutePath, 'utf8'),
        writeFile: (location, content) =>
          writeFile(location.absolutePath, content, 'utf8'),
        confirm: (message) => this.ui.confirmAcceptFile(message),
        // The desktop main process has no `workspaceFilesWritten` subscriber
        // (file decorations are a VS Code surface), so there is nothing to
        // notify.
        emitWritten: () => undefined,
        showInfo: (message) => this.ui.showInfoMessage(message),
        deleteFile: async (location) => {
          try {
            await AbsoluteFS.delete(location.absolutePath);
          } catch {
            // Non-fatal: diff file may not exist or may be locked.
          }
        },
      },
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
    if (!outcome || outcome.results.length === 0) {
      await this.ui.showInfoMessage(
        'No LaTeX diff operations available for this run.',
      );
      return;
    }

    if (await this.openSharedLatexdiffResults(outcome)) return;

    await this.ui.showErrorMessage(
      `All LaTeX diff operations failed (math markup: "${DEFAULT_MATH_MARKUP}").`,
    );
  }

  async runLatexdiffFile(baseFile: string, editedFile: string): Promise<void> {
    const service = new LaTeXdiffService(DESKTOP_LATEXDIFF_CHANNEL);
    const result = await service.runDiff(
      pathToLocation(baseFile),
      pathToLocation(editedFile),
      '_diff',
      DEFAULT_MATH_MARKUP,
    );

    if (!result.success || !result.diffFileName) {
      await this.ui.showErrorMessage(
        result.message ?? 'Failed to generate diff file.',
      );
      return;
    }

    const diffFilePath = path.join(path.dirname(baseFile), result.diffFileName);
    await this.openDiffOutput(diffFilePath);
  }

  async findAndOpenLabel(label: string): Promise<boolean> {
    const candidates = new Set(await this.host.listWorkspaceCandidateFiles());
    return openFirstLabelMatch(
      label,
      candidates,
      (file) => readFile(file, 'utf8'),
      (file) => this.ui.openPath(file),
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
    // auto-discovery → workspace scan) to the single host-neutral core shared
    // with the VS Code command and the CLI, instead of re-implementing it here.
    // Desktop has no per-operation progress UI.
    const progress: DiffProgressReporter = { report: () => undefined };
    try {
      const { outcome } = await runLatexdiffForExecution({
        agent: scan?.agent ?? '',
        model: scan?.model ?? '',
        inputFile: scan?.inputFile ?? '',
        outputFiles: scan?.outputFiles,
        runId: runContext.executionId ?? null,
        outputsByRound: hasOutputs ? runContext.outputsByRound : null,
        mathMarkup: DEFAULT_MATH_MARKUP,
        generateBetweenRoundDiffs: true,
        latexdiff: {
          channel: DESKTOP_LATEXDIFF_CHANNEL,
          service: new LaTeXdiffService(DESKTOP_LATEXDIFF_CHANNEL),
        },
        progress,
      });
      return outcome;
    } catch (error) {
      // The core can throw (e.g. no workspace path). Don't abort the whole
      // action — return undefined so the caller falls back to single-file —
      // but log the cause so a systematic round-aware failure isn't silently
      // downgraded to single-file diffs with no trace.
      console.error(
        `Round-aware LaTeX diff failed; falling back to single-file diff: ${toErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Open every successful diff (between-round runs produce many), mirroring the
   * VS Code command. Returns whether at least one diff was opened, so the
   * caller can fall back to a single-file diff when none were.
   */
  private async openSharedLatexdiffResults(
    outcome: DiffRunOutcome,
  ): Promise<boolean> {
    const successes = outcome.results.filter(
      (
        entry,
      ): entry is DiffRunResult & { basePath: string; diffFileName: string } =>
        entry.success && Boolean(entry.basePath) && Boolean(entry.diffFileName),
    );

    for (const result of successes) {
      const diffFilePath = path.join(
        path.dirname(result.basePath),
        result.diffFileName,
      );
      await this.openDiffOutput(diffFilePath);
    }

    return successes.length > 0;
  }

  /** Open a generated diff file via the desktop LaTeX build display. */
  private openDiffOutput(diffFilePath: string): Promise<void> {
    return this.ui.openBuildDisplay(createExternalLocation(diffFilePath));
  }
}
