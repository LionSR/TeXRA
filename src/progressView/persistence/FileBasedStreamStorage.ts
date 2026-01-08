// Third-party imports
import * as path from 'path';

// Local imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { AgentLogger } from '@logger/AgentLogger';
import { StorageFS } from '@utils/files/storageFS';

/**
 * Directory name for progress view storage within StorageFS base path.
 */
const PROGRESS_STORAGE_DIR = 'progress';

/**
 * File-based storage for stream data to avoid VS Code workspaceState IPC limits.
 *
 * Stores heavy data (messages, task groups, output files, etc.) in individual
 * files per stream, enabling lazy loading when streams are accessed.
 */
export class FileBasedStreamStorage {
  private readonly logger = new AgentLogger('FileBasedStreamStorage');
  private readonly cache = new Map<string, Map<StreamTabId, unknown>>();

  /**
   * Get the storage directory for a specific data type.
   */
  private getStorageDir(dataType: string): string {
    return path.join(PROGRESS_STORAGE_DIR, dataType);
  }

  /**
   * Get the file path for a specific stream's data.
   */
  private getFilePath(dataType: string, streamId: StreamTabId): string {
    // Sanitize stream ID for use as filename (replace invalid chars)
    const safeId = streamId.replaceAll(/[<>:"/\\|?*]/g, '_');
    return path.join(this.getStorageDir(dataType), `${safeId}.json`);
  }

  /**
   * Save data for a specific stream.
   */
  async save<T>(
    dataType: string,
    streamId: StreamTabId,
    data: T,
  ): Promise<void> {
    try {
      const filePath = this.getFilePath(dataType, streamId);
      await StorageFS.writeJson(filePath, data);

      // Update cache
      let typeCache = this.cache.get(dataType);
      if (!typeCache) {
        typeCache = new Map();
        this.cache.set(dataType, typeCache);
      }
      typeCache.set(streamId, data);
    } catch (error) {
      this.logger.error(`Failed to save ${dataType} for stream ${streamId}`, {
        data: error,
      });
      throw error;
    }
  }

  /**
   * Load data for a specific stream (lazy loading with cache).
   */
  async load<T>(dataType: string, streamId: StreamTabId): Promise<T | null> {
    // Check cache first
    const typeCache = this.cache.get(dataType);
    if (typeCache?.has(streamId)) {
      return typeCache.get(streamId) as T;
    }

    try {
      const filePath = this.getFilePath(dataType, streamId);
      const exists = await StorageFS.exists(filePath);
      if (!exists) {
        return null;
      }

      const data = await StorageFS.readJson<T>(filePath);

      // Update cache
      let cache = this.cache.get(dataType);
      if (!cache) {
        cache = new Map();
        this.cache.set(dataType, cache);
      }
      cache.set(streamId, data);

      return data;
    } catch (error) {
      this.logger.warn(`Failed to load ${dataType} for stream ${streamId}`, {
        data: error,
      });
      return null;
    }
  }

  /**
   * Delete data for a specific stream.
   */
  async delete(dataType: string, streamId: StreamTabId): Promise<void> {
    try {
      const filePath = this.getFilePath(dataType, streamId);
      const exists = await StorageFS.exists(filePath);
      if (exists) {
        await StorageFS.delete(filePath);
      }

      // Clear from cache
      this.cache.get(dataType)?.delete(streamId);
    } catch (error) {
      this.logger.warn(`Failed to delete ${dataType} for stream ${streamId}`, {
        data: error,
      });
    }
  }

  /**
   * Delete all data for a specific stream across all data types.
   */
  async deleteStream(streamId: StreamTabId): Promise<void> {
    const dataTypes = [
      'streamTabs',
      'taskGroups',
      'outputFiles',
      'missingOutputs',
      'usageStats',
      'runInstructions',
      'taskStates',
    ];

    await Promise.all(
      dataTypes.map((dataType) => this.delete(dataType, streamId)),
    );
  }

  /**
   * List all stream IDs that have data for a specific data type.
   */
  async listStreams(dataType: string): Promise<StreamTabId[]> {
    try {
      const dir = this.getStorageDir(dataType);
      const exists = await StorageFS.exists(dir);
      if (!exists) {
        return [];
      }

      const entries = await StorageFS.readDir(dir);
      return entries
        .filter(([name]) => name.endsWith('.json'))
        .map(([name]) => name.replace('.json', '') as StreamTabId);
    } catch (error) {
      this.logger.warn(`Failed to list streams for ${dataType}`, {
        data: error,
      });
      return [];
    }
  }

  /**
   * Clear all cached data.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clear cache for a specific stream.
   */
  clearStreamCache(streamId: StreamTabId): void {
    for (const typeCache of this.cache.values()) {
      typeCache.delete(streamId);
    }
  }

  /**
   * Clear all data (files and cache).
   */
  async clearAll(): Promise<void> {
    try {
      const exists = await StorageFS.exists(PROGRESS_STORAGE_DIR);
      if (exists) {
        await StorageFS.delete(PROGRESS_STORAGE_DIR);
      }
      this.cache.clear();
    } catch (error) {
      this.logger.error('Failed to clear all progress storage', {
        data: error,
      });
    }
  }
}

/**
 * Singleton instance of FileBasedStreamStorage.
 */
export const streamStorage = new FileBasedStreamStorage();
