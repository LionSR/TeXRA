import path from 'path';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - shared
import type { OutputFileInfo, StreamTabId } from '@shared/schemas';

// Local imports - utilities
import { ensureRunDir, getRunDir, resolveRunDir } from '@utils/files';

/** Agent + model for the run that produced a file, used to build the
 *  legacy `<base>_<agent>_r<round>_<model>` postfix when accepting a copy. */
export interface AcceptCopyMeta {
  agent: string;
  model: string;
  round: number;
}

export interface ProgressWorkflowFileActionsState {
  getActiveStream(): StreamTabId | '';
  getExecutionId(stream: StreamTabId): string | undefined;
  getOutputFiles(stream: StreamTabId): Map<number, OutputFileInfo[]>;
  getAgentModel(
    stream: StreamTabId,
  ): { agent: string; model: string } | undefined;
}

export interface ProgressWorkflowFileActionsHost {
  compareFiles(baseFile: string, editedFile: string): Promise<void>;
  acceptEditedFile(
    baseFile: string,
    editedFile: string,
    copyMeta?: AcceptCopyMeta,
  ): Promise<boolean | void>;
  mergeFile(baseFile: string, editedFile: string): Promise<void>;
  latexdiffFile(baseFile: string, editedFile: string): Promise<void>;
  openDirectory(directory: string): Promise<void>;
  openLabel(label: string): Promise<boolean>;
  readFile(file: string): Promise<string>;
  showInfo(message: string): Promise<void>;
  showError(message: string): Promise<void>;
  logError?(message: string, error: unknown): void;
}

export interface ProgressWorkflowFileActionsControllerDeps {
  state: ProgressWorkflowFileActionsState;
  host: ProgressWorkflowFileActionsHost;
  sendFollowUp(stream: StreamTabId, text: string): Promise<void>;
  modelOutputBackups?: Map<StreamTabId, Map<string, ModelOutputBackup>>;
}

type ModelOutputBackup = {
  content: string;
  streamId: StreamTabId;
};

export class ProgressWorkflowFileActionsController {
  private readonly modelOutputBackups: Map<
    StreamTabId,
    Map<string, ModelOutputBackup>
  >;

  constructor(
    private readonly deps: ProgressWorkflowFileActionsControllerDeps,
  ) {
    this.modelOutputBackups = deps.modelOutputBackups ?? new Map();
  }

  async openTaskStorage(stream: StreamTabId): Promise<void> {
    try {
      const executionId = this.deps.state.getExecutionId(stream);
      const runOutputs = this.deps.state.getOutputFiles(stream);
      let directoryToReveal: string | undefined;

      if (executionId) {
        directoryToReveal = await resolveRunDir(executionId);
        if (!directoryToReveal) {
          await ensureRunDir(executionId);
          directoryToReveal = getRunDir(executionId);
        }
      } else if (runOutputs.size > 0) {
        directoryToReveal = this.findOutputDirectory(runOutputs);
      }

      if (!directoryToReveal) {
        await this.deps.host.showInfo(
          'No task storage folder is available for this run yet.',
        );
        return;
      }

      await this.deps.host.openDirectory(directoryToReveal);
    } catch (error) {
      this.deps.host.logError?.('Failed to open task storage folder', error);
      await this.deps.host.showError(
        `Failed to open task storage folder: ${toErrorMessage(error)}`,
      );
    }
  }

  async compareOriginal(file: string, base?: string): Promise<void> {
    await this.executeWithBaseFile(
      file,
      base,
      'Compare original',
      async (targetFile, baseFile) => {
        await this.backupModelOutput(file);
        await this.deps.host.compareFiles(baseFile, targetFile);
      },
    );
  }

  async comparePrevious(
    file: string,
    base?: string,
    previous?: string,
  ): Promise<void> {
    const previousFile = previous ?? base;
    if (!previousFile) {
      await this.deps.host.showInfo('Compare previous needs a base file.');
      return;
    }

    await this.deps.host.compareFiles(previousFile, file);
  }

  async acceptFile(file: string, base?: string): Promise<void> {
    const activeStream = this.deps.state.getActiveStream();
    const backup =
      file && activeStream
        ? this.modelOutputBackups.get(activeStream)?.get(file)
        : undefined;
    let currentContent: string | undefined;

    if (backup) {
      try {
        currentContent = await this.deps.host.readFile(file);
      } catch {
        currentContent = undefined;
      }
    }

    const copyMeta =
      activeStream && file ? this.buildCopyMeta(activeStream, file) : undefined;

    const accepted = await this.executeWithBaseFile(
      file,
      base,
      'Accept',
      async (targetFile, baseFile) => {
        return this.deps.host.acceptEditedFile(baseFile, targetFile, copyMeta);
      },
    );
    if (!accepted) return;

    if (
      backup &&
      currentContent !== undefined &&
      currentContent !== backup.content
    ) {
      const fileName = path.basename(file);
      await this.deps.sendFollowUp(
        backup.streamId,
        `[System: User modified the model's suggested output for "${fileName}" before accepting. The accepted version differs from the original model output.]`,
      );
    }

    if (backup && activeStream) {
      const streamBackups = this.modelOutputBackups.get(activeStream);
      streamBackups?.delete(file);
      if (streamBackups?.size === 0) {
        this.modelOutputBackups.delete(activeStream);
      }
    }
  }

  async mergeFile(file: string, base?: string): Promise<void> {
    await this.executeWithBaseFile(
      file,
      base,
      'Merge',
      async (targetFile, baseFile) => {
        await this.deps.host.mergeFile(baseFile, targetFile);
      },
    );
  }

  async latexdiffFile(file: string, base?: string): Promise<void> {
    await this.executeWithBaseFile(
      file,
      base,
      'Latexdiff',
      async (targetFile, baseFile) => {
        await this.deps.host.latexdiffFile(baseFile, targetFile);
      },
    );
  }

  async openLabel(label: string): Promise<void> {
    const opened = await this.deps.host.openLabel(label);
    if (!opened) {
      await this.deps.host.showInfo(`Label "${label}" not found.`);
    }
  }

  clearStreamBackups(stream: StreamTabId): void {
    this.modelOutputBackups.delete(stream);
  }

  clearAllBackups(): void {
    this.modelOutputBackups.clear();
  }

  private async executeWithBaseFile(
    file: string,
    base: string | undefined,
    actionName: string,
    execute: (file: string, base: string) => Promise<boolean | void>,
  ): Promise<boolean> {
    if (!base) {
      await this.deps.host.showInfo(`${actionName} needs a base file.`);
      return false;
    }
    return (await execute(file, base)) !== false;
  }

  private async backupModelOutput(file: string): Promise<void> {
    const streamId = this.deps.state.getActiveStream();
    if (!streamId || !file) return;

    try {
      const content = await this.deps.host.readFile(file);
      const streamBackups = this.modelOutputBackups.get(streamId) ?? new Map();
      streamBackups.set(file, { content, streamId });
      this.modelOutputBackups.set(streamId, streamBackups);
    } catch {
      // Best-effort: backup only informs the accepted-edit follow-up.
    }
  }

  /** Resolve the agent/model/round for an output file so "Accept" can offer
   *  a postfixed copy. Returns undefined when the run's agent/model or the
   *  file's round can't be determined (the quick-pick then just replaces). */
  private buildCopyMeta(
    stream: StreamTabId,
    file: string,
  ): AcceptCopyMeta | undefined {
    const config = this.deps.state.getAgentModel(stream);
    if (!config) return undefined;

    for (const [round, infos] of this.deps.state.getOutputFiles(stream)) {
      if (infos.some((info) => info.location.absolutePath === file)) {
        return { agent: config.agent, model: config.model, round };
      }
    }
    return undefined;
  }

  private findOutputDirectory(
    runOutputs: Map<number, OutputFileInfo[]>,
  ): string | undefined {
    for (const infos of runOutputs.values()) {
      for (const info of infos) {
        const kind = info.location.kind;
        if (kind === 'runStorage' || kind === 'workspace') {
          return path.dirname(info.location.absolutePath);
        }
      }
    }
    return undefined;
  }
}
