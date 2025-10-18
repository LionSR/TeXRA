// Local imports - progress view
import { PersistentMapManager } from '../persistence/PersistentMapManager';
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';

// Local imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { WorkspaceFS } from '@utils/files';

// Local imports - state helpers
import {
  MIGRATION_PLACEHOLDER_ID,
  SESSION_PLACEHOLDER_IDS,
} from '../state/sessionPlaceholders';

// Types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';

/**
 * Manages output files collection with persistence and file existence validation.
 * Handles adding, updating, and managing output files for different streams and sessions.
 *
 * Storage structure: Map<StreamId, { [groupId: string]: { [round: number]: OutputFileInfo[] } }>
 */
export class OutputFilesManager extends PersistentMapManager<
  StreamTabId,
  { [groupId: string]: { [key: number]: OutputFileInfo[] } }
> {
  private _missingOutputs: Map<
    StreamTabId,
    { [groupId: string]: { [key: number]: string[] } }
  > = new Map();
  private readonly logger: AgentLogger;
  private totalFilesProcessed = 0;
  private totalFilesRemoved = 0;

  constructor(persistence: StatePersistenceManager) {
    super(persistence, WorkspaceStateKey.OUTPUT_FILES);
    this.logger = new AgentLogger('OutputFilesManager');
  }

  /** Add output files for a stream, session, and round */
  addFiles(
    stream: StreamTabId,
    groupId: string,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): void {
    const existing = this.get(stream) || {};
    const sessionFiles = existing[groupId] || {};
    const merged = { ...sessionFiles, ...filesByRound };
    existing[groupId] = merged;
    this.add(stream, existing);
  }

  /** Update missing outputs for a stream and session */
  updateMissingOutputs(
    stream: StreamTabId,
    groupId: string,
    filesByRound: { [key: number]: string[] },
  ): void {
    if (!this._missingOutputs.has(stream)) {
      this._missingOutputs.set(stream, {});
    }

    const streamMissing = this._missingOutputs.get(stream)!;
    if (!streamMissing[groupId]) {
      streamMissing[groupId] = {};
    }

    for (const [round, files] of Object.entries(filesByRound)) {
      const roundNum = parseInt(round, 10);
      streamMissing[groupId][roundNum] = files;
    }

    this.saveMissingOutputs();
  }

  /** Get output files for a stream and specific session */
  getFiles(
    stream: StreamTabId,
    groupId?: string,
  ): { [key: number]: OutputFileInfo[] } | undefined {
    const streamData = this.get(stream);
    if (!streamData) {
      return undefined;
    }

    if (groupId) {
      return streamData[groupId];
    }

    for (const placeholder of SESSION_PLACEHOLDER_IDS) {
      const placeholderData = streamData[placeholder];
      if (placeholderData) {
        return placeholderData;
      }
    }

    return undefined;
  }

  /** Get all sessions' files for a stream */
  getAllSessionFiles(
    stream: StreamTabId,
  ): { [groupId: string]: { [key: number]: OutputFileInfo[] } } | undefined {
    return this.get(stream);
  }

  /** Get missing outputs for a stream and session */
  getMissingOutputs(
    stream: StreamTabId,
    groupId?: string,
  ): { [key: number]: string[] } | undefined {
    const streamMissing = this._missingOutputs.get(stream);
    if (!streamMissing) {
      return undefined;
    }

    if (groupId) {
      return streamMissing[groupId];
    }

    for (const placeholder of SESSION_PLACEHOLDER_IDS) {
      const placeholderData = streamMissing[placeholder];
      if (placeholderData) {
        return placeholderData;
      }
    }

    return undefined;
  }

  /** Clear output files for a specific session */
  clearSessionFiles(stream: StreamTabId, groupId: string): void {
    const existing = this.get(stream);
    if (existing && existing[groupId]) {
      delete existing[groupId];
      this.add(stream, existing);
    }
  }

  /** Clear missing outputs for a specific session */
  clearSessionMissingOutputs(stream: StreamTabId, groupId: string): void {
    const streamMissing = this._missingOutputs.get(stream);
    if (streamMissing && streamMissing[groupId]) {
      delete streamMissing[groupId];
      this.saveMissingOutputs();
    }
  }

  /** Clear output files for entire stream */
  clearFiles(stream: StreamTabId): void {
    this.delete(stream);
  }

  /** Clear missing outputs for entire stream */
  clearMissingOutputs(stream: StreamTabId): void {
    this._missingOutputs.delete(stream);
    this.saveMissingOutputs();
  }

  /** Delete all files for a stream */
  deleteStream(stream: StreamTabId): void {
    super.delete(stream);
    this._missingOutputs.delete(stream);
    this.saveMissingOutputs();
  }

  /** Clear all output files */
  clear(): void {
    super.clear();
    this._missingOutputs.clear();
    this.saveMissingOutputs();
  }

  /** Get all output files */
  getAllFiles(): Map<
    StreamTabId,
    { [groupId: string]: { [key: number]: OutputFileInfo[] } }
  > {
    return this.getAll();
  }

  /** Get all missing outputs */
  getAllMissingOutputs(): Map<
    StreamTabId,
    { [groupId: string]: { [key: number]: string[] } }
  > {
    return new Map(this._missingOutputs);
  }

  /** Set all output files (used during loading) */
  setAllFiles(
    files: Map<
      StreamTabId,
      { [groupId: string]: { [key: number]: OutputFileInfo[] } }
    >,
  ): void {
    this.setAll(files);
  }

  /** Set all missing outputs (used during loading) */
  setAllMissingOutputs(
    missing: Map<
      StreamTabId,
      { [groupId: string]: { [key: number]: string[] } }
    >,
  ): void {
    this._missingOutputs = new Map(missing);
  }

  /** Load output files from persistence and clean up missing files */
  async load(): Promise<void> {
    this.totalFilesProcessed = 0;
    this.totalFilesRemoved = 0;
    await super.load();
    await this.loadMissingOutputs();
    if (this.totalFilesRemoved > 0) {
      this.logger.info(
        `File cleanup completed: processed ${this.totalFilesProcessed} files, removed ${this.totalFilesRemoved} missing files`,
      );
    }
  }

  /** Load missing outputs from persistence */
  private async loadMissingOutputs(): Promise<void> {
    const saved = await this.persistence.load<{
      [key: string]: any;
    }>(WorkspaceStateKey.MISSING_OUTPUTS, {});

    if (saved && Object.keys(saved).length > 0) {
      const processed = new Map<
        StreamTabId,
        { [groupId: string]: { [key: number]: string[] } }
      >();

      for (const [stream, data] of Object.entries(saved)) {
        // Check if this is old format (rounds directly) or new format (groupId -> rounds)
        const firstKey = Object.keys(data)[0];
        const firstValue = firstKey ? (data as any)[firstKey] : undefined;
        const isOldFormat = Array.isArray(firstValue);

        if (isOldFormat) {
          // Old format: migrate to latest session
          this.logger.info(
            `Migrating old format missing outputs for stream ${stream} to latest session`,
          );
          const roundMap = Object.fromEntries(
            Object.entries(data).map(([r, files]) => [
              parseInt(r, 10),
              files as string[],
            ]),
          );
          // Will be attributed to latest session by parent logic
          processed.set(stream, { [MIGRATION_PLACEHOLDER_ID]: roundMap });
        } else {
          // New format: already has groupIds
          const groupMap: { [groupId: string]: { [key: number]: string[] } } =
            {};
          for (const [groupId, rounds] of Object.entries(data)) {
            const roundMap: { [key: number]: string[] } = {};
            for (const [r, files] of Object.entries(rounds as any)) {
              roundMap[parseInt(r, 10)] = files as string[];
            }
            groupMap[groupId] = roundMap;
          }
          processed.set(stream, groupMap);
        }
      }

      this._missingOutputs = processed;
    } else {
      this._missingOutputs.clear();
    }
  }

  /** Save missing outputs to persistence */
  saveMissingOutputs(): void {
    const obj = Object.fromEntries(this._missingOutputs.entries());
    this.persistence.save(WorkspaceStateKey.MISSING_OUTPUTS, obj);
  }

  /** Validate and normalize loaded output files */
  protected override async deserialize(
    data: unknown,
    streamId: StreamTabId,
  ): Promise<{ [groupId: string]: { [key: number]: OutputFileInfo[] } }> {
    // Check if this is old format or new format
    const obj = data as Record<string, any>;
    const firstKey = Object.keys(obj)[0];
    const firstValue = firstKey ? obj[firstKey] : undefined;
    const isOldFormat = Array.isArray(firstValue);

    if (isOldFormat) {
      // Old format: { [round: number]: OutputFileInfo[] }
      // Migrate to new format with __MIGRATION__ placeholder
      this.logger.info(
        `Migrating old format output files for stream ${streamId} to latest session`,
      );

      const rounds = obj as { [key: number]: OutputFileInfo[] };
      const roundMap: { [key: number]: OutputFileInfo[] } = {};
      const streamFilesProcessed = Object.values(rounds).reduce(
        (sum, files) => sum + files.length,
        0,
      );
      this.totalFilesProcessed += streamFilesProcessed;

      for (const [roundStr, infos] of Object.entries(rounds)) {
        const roundNum = parseInt(roundStr, 10);
        try {
          const filtered = await WorkspaceFS.filterExistingFiles(infos);
          const removedCount = infos.length - filtered.length;
          if (removedCount > 0) {
            this.totalFilesRemoved += removedCount;
          }
          if (filtered.length > 0) {
            roundMap[roundNum] = filtered;
          }
        } catch (error) {
          this.logger.warn(
            `Error checking files in stream ${streamId}, round ${roundNum}: ${error instanceof Error ? error.message : String(error)}`,
          );
          roundMap[roundNum] = infos;
        }
      }

      // Return with migration marker - will be resolved by ProgressViewState
      return { [MIGRATION_PLACEHOLDER_ID]: roundMap };
    } else {
      // New format: { [groupId: string]: { [round: number]: OutputFileInfo[] } }
      const sessions = obj as {
        [groupId: string]: { [key: number]: OutputFileInfo[] };
      };
      const result: { [groupId: string]: { [key: number]: OutputFileInfo[] } } =
        {};

      for (const [groupId, rounds] of Object.entries(sessions)) {
        const roundMap: { [key: number]: OutputFileInfo[] } = {};
        const sessionFilesProcessed = Object.values(rounds).reduce(
          (sum, files) => sum + files.length,
          0,
        );
        this.totalFilesProcessed += sessionFilesProcessed;

        for (const [roundStr, infos] of Object.entries(rounds)) {
          const roundNum = parseInt(roundStr, 10);
          try {
            const filtered = await WorkspaceFS.filterExistingFiles(infos);
            const removedCount = infos.length - filtered.length;
            if (removedCount > 0) {
              this.totalFilesRemoved += removedCount;
            }
            if (filtered.length > 0) {
              roundMap[roundNum] = filtered;
            }
          } catch (error) {
            this.logger.warn(
              `Error checking files for stream ${streamId}, session ${groupId}, round ${roundNum}: ${error instanceof Error ? error.message : String(error)}`,
            );
            roundMap[roundNum] = infos;
          }
        }

        if (Object.keys(roundMap).length > 0) {
          result[groupId] = roundMap;
        }
      }

      return result;
    }
  }

  /**
   * Merge session-specific data from a placeholder group into the target session.
   * Returns true when data was migrated.
   */
  mergeSessionData(
    stream: StreamTabId,
    sourceGroupId: string,
    targetGroupId: string,
  ): boolean {
    if (!sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId) {
      return false;
    }

    const streamData = this.get(stream);
    const source = streamData?.[sourceGroupId];
    const target = streamData?.[targetGroupId] || {};

    const hasFileData = Boolean(source && Object.keys(source).length > 0);

    if (streamData && source) {
      const merged: { [key: number]: OutputFileInfo[] } = { ...target };
      for (const [round, infos] of Object.entries(source)) {
        const roundNum = Number(round);
        const existing = merged[roundNum] ?? [];
        merged[roundNum] = [...existing, ...infos];
      }
      streamData[targetGroupId] = merged;
      delete streamData[sourceGroupId];
      this.add(stream, streamData);
    }

    const streamMissing = this._missingOutputs.get(stream);
    const sourceMissing = streamMissing?.[sourceGroupId];
    if (streamMissing && sourceMissing) {
      const targetMissing = streamMissing[targetGroupId] || {};
      const mergedMissing: { [key: number]: string[] } = { ...targetMissing };
      for (const [round, files] of Object.entries(sourceMissing)) {
        const roundNum = Number(round);
        const existing = mergedMissing[roundNum] ?? [];
        const unique = new Set([...existing, ...files]);
        mergedMissing[roundNum] = Array.from(unique);
      }
      streamMissing[targetGroupId] = mergedMissing;
      delete streamMissing[sourceGroupId];
      this.saveMissingOutputs();
    }

    return hasFileData || Boolean(sourceMissing);
  }

  /**
   * Convenience helper to migrate all known placeholder sessions to a target.
   */
  migratePlaceholders(stream: StreamTabId, targetGroupId: string): boolean {
    let migrated = false;
    for (const placeholder of SESSION_PLACEHOLDER_IDS) {
      migrated =
        this.mergeSessionData(stream, placeholder, targetGroupId) || migrated;
    }
    return migrated;
  }
}
