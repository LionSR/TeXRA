// Local imports - progress view
import { PersistentMapManager } from '../persistence/PersistentMapManager';
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';

// Local imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { WorkspaceFS } from '@utils/files';

// Types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';

type FilesByRound<T> = { [key: number]: T[] };

interface StreamOutputState {
  files: FilesByRound<OutputFileInfo>;
  missing: FilesByRound<string>;
}

function createEmptyState(): StreamOutputState {
  return { files: {}, missing: {} };
}

/**
 * Manages output files collection with persistence.
 * Stores output and missing entries in a single structure per stream.
 */
export class OutputFilesManager extends PersistentMapManager<
  StreamTabId,
  StreamOutputState
> {
  private readonly logger: AgentLogger;
  private totalFilesProcessed = 0;
  private totalFilesRemoved = 0;

  constructor(persistence: StatePersistenceManager) {
    super(persistence, WorkspaceStateKey.OUTPUT_FILES);
    this.logger = new AgentLogger('OutputFilesManager');
  }

  addFiles(stream: StreamTabId, filesByRound: FilesByRound<OutputFileInfo>): void {
    const state = this.ensureState(stream);
    for (const [round, files] of Object.entries(filesByRound)) {
      state.files[Number(round)] = files;
    }
    this.save();
  }

  updateMissingOutputs(stream: StreamTabId, filesByRound: FilesByRound<string>): void {
    const state = this.ensureState(stream);
    for (const [round, files] of Object.entries(filesByRound)) {
      state.missing[Number(round)] = files;
    }
    this.save();
  }

  getFiles(stream: StreamTabId): FilesByRound<OutputFileInfo> {
    return this.items.get(stream)?.files ?? {};
  }

  getMissingOutputs(stream: StreamTabId): FilesByRound<string> {
    return this.items.get(stream)?.missing ?? {};
  }

  clearFiles(stream: StreamTabId): void {
    const state = this.items.get(stream);
    if (!state) {
      return;
    }
    state.files = {};
    this.save();
  }

  clearMissingOutputs(stream: StreamTabId): void {
    const state = this.items.get(stream);
    if (!state) {
      return;
    }
    state.missing = {};
    this.save();
  }

  deleteStream(stream: StreamTabId): void {
    super.delete(stream);
  }

  clear(): void {
    super.clear();
  }

  async load(): Promise<void> {
    this.totalFilesProcessed = 0;
    this.totalFilesRemoved = 0;
    await super.load();
    if (this.totalFilesRemoved > 0) {
      this.logger.info(
        `File cleanup completed: processed ${this.totalFilesProcessed} files, removed ${this.totalFilesRemoved} missing files`,
      );
    }
  }

  protected override serialize(
    value: StreamOutputState,
    _key: StreamTabId,
  ): unknown {
    return value;
  }

  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<StreamOutputState> {
    if (!data || typeof data !== 'object') {
      return createEmptyState();
    }

    const raw = data as Partial<StreamOutputState> & {
      [round: string]: OutputFileInfo[];
    };

    const filesSource = raw.files ?? this.extractLegacyFiles(raw);
    const missingSource = raw.missing ?? {};

    const files = await this.normalizeFiles(filesSource);
    const missing = this.normalizeMissing(missingSource);

    return { files, missing };
  }

  private ensureState(stream: StreamTabId): StreamOutputState {
    let state = this.items.get(stream);
    if (!state) {
      state = createEmptyState();
      this.items.set(stream, state);
    }
    return state;
  }

  private extractLegacyFiles(
    legacy: Record<string, OutputFileInfo[]>,
  ): FilesByRound<OutputFileInfo> {
    const normalized: FilesByRound<OutputFileInfo> = {};
    for (const [round, files] of Object.entries(legacy)) {
      const roundNum = Number.parseInt(round, 10);
      if (!Number.isNaN(roundNum) && Array.isArray(files)) {
        normalized[roundNum] = files;
      }
    }
    return normalized;
  }

  private normalizeMissing(source: FilesByRound<string>): FilesByRound<string> {
    const normalized: FilesByRound<string> = {};
    for (const [round, files] of Object.entries(source)) {
      const roundNum = Number.parseInt(round, 10);
      if (!Number.isNaN(roundNum) && Array.isArray(files)) {
        normalized[roundNum] = files;
      }
    }
    return normalized;
  }

  private async normalizeFiles(
    source: FilesByRound<OutputFileInfo>,
  ): Promise<FilesByRound<OutputFileInfo>> {
    const normalized: FilesByRound<OutputFileInfo> = {};

    for (const [round, infos] of Object.entries(source)) {
      const roundNum = Number.parseInt(round, 10);
      if (Number.isNaN(roundNum) || !Array.isArray(infos)) {
        continue;
      }

      this.totalFilesProcessed += infos.length;

      try {
        const filtered = await WorkspaceFS.filterExistingFiles(infos);
        const removed = infos.length - filtered.length;
        if (removed > 0) {
          this.totalFilesRemoved += removed;
        }
        if (filtered.length > 0) {
          normalized[roundNum] = filtered;
        }
      } catch {
        normalized[roundNum] = infos;
      }
    }

    return normalized;
  }
}
