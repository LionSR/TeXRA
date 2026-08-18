// Node imports
import path from 'node:path';

// Local imports
import { createLog } from '@logger/logUtils';
import type {
  AcceptCopyMeta,
  OutputFileInfo,
  RoundIndexed,
  StreamTabId,
} from '@shared/schemas';
import { ensureRunDir, findRunDir, getRunDir } from '@utils/files/runStorageFs';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { StreamOutputsSource } from './streamOutputs';

const log = createLog('ProgressWorkflowFileActions');

interface ProgressWorkflowFileActionsState extends StreamOutputsSource {
  getActiveStream(): StreamTabId | '';
}

interface ProgressWorkflowFileActionsHost {
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
}

export class ProgressWorkflowFileActionsController {
  /** Per-stream snapshot of each output file's content at compare time. */
  private readonly modelOutputBackups = new Map<
    StreamTabId,
    Map<string, string>
  >();

  constructor(
    private readonly deps: ProgressWorkflowFileActionsControllerDeps,
  ) {}

  async openTaskStorage(stream: StreamTabId): Promise<void> {
    try {
      await this.deps.state.preload?.(stream);
      const { executionId } = this.deps.state.getRunMetadata(stream);
      const runOutputs = this.deps.state.getOutputFiles(stream);
      let directoryToReveal: string | undefined;

      if (executionId) {
        directoryToReveal = await findRunDir(executionId);
        if (!directoryToReveal) {
          await ensureRunDir(executionId);
          directoryToReveal = getRunDir(executionId);
        }
      } else if (Object.keys(runOutputs).length > 0) {
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

    if (backup !== undefined) {
      try {
        currentContent = await this.deps.host.readFile(file);
      } catch (error) {
        log.debug(`Could not read current content of ${file} before accept`, {
          data: error,
        });
      }
    }

    let copyMeta: AcceptCopyMeta | undefined;
    if (activeStream && file) {
      await this.deps.state.preload?.(activeStream);
      copyMeta = this.buildCopyMeta(activeStream, file);
    }

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
      backup !== undefined &&
      currentContent !== undefined &&
      currentContent !== backup
    ) {
      const fileName = path.basename(file);
      await this.deps.sendFollowUp(
        activeStream,
        `[System: User modified the model's suggested output for "${fileName}" before accepting. The accepted version differs from the original model output.]`,
      );
    }

    if (backup !== undefined && activeStream) {
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
      streamBackups.set(file, content);
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
    const { config } = this.deps.state.getRunMetadata(stream);
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

  private findOutputDirectory(
    runOutputs: RoundIndexed<OutputFileInfo>,
  ): string | undefined {
    const match = Object.values(runOutputs)
      .flat()
      .find(
        ({ location }) =>
          location.kind === 'runStorage' || location.kind === 'workspace',
      );
    return match ? path.dirname(match.location.absolutePath) : undefined;
  }
}
