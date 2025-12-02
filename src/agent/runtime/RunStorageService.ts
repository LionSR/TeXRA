/**
 * RunStorageService - Abstracts run state storage from UI components.
 *
 * This service decouples the agent runtime from the ProgressView UI layer,
 * allowing agents to run without requiring the UI to be initialized.
 * This enables headless execution and easier testing.
 */

// Type imports
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamTabId, StorageKey } from '@agent/types/IdentifierTypes';

/**
 * Interface for accessing run storage state.
 *
 * This interface abstracts the storage operations needed by the agent runtime,
 * breaking the direct dependency on ProgressViewProvider.
 */
export interface IRunStorageService {
  /**
   * Get the active run ID for a stream.
   * For workflow agents this is a task group ID, for tool-use it's the execution ID.
   */
  getActiveRunId(stream: StreamTabId): StorageKey | null;

  /**
   * Get output files for a specific run within a stream.
   * @param stream - The stream tab ID
   * @param options.storageKey - The branded key for storage lookup
   * @returns Map of round number to output file info, or undefined if not found
   */
  getRunOutputFiles(
    stream: StreamTabId,
    options: { storageKey: StorageKey },
  ): Map<number, OutputFileInfo[]> | undefined;

  /**
   * Check if the progress view is currently visible.
   * Used to determine whether to show notifications.
   */
  isViewVisible(): boolean;
}

/**
 * Null implementation for when no storage service is available.
 * Returns safe defaults that allow agent execution to proceed.
 */
export class NullRunStorageService implements IRunStorageService {
  getActiveRunId(_stream: StreamTabId): StorageKey | null {
    return null;
  }

  getRunOutputFiles(
    _stream: StreamTabId,
    _options: { storageKey: StorageKey },
  ): Map<number, OutputFileInfo[]> | undefined {
    return undefined;
  }

  isViewVisible(): boolean {
    return false;
  }
}

/**
 * Registry for the run storage service.
 *
 * Uses a simple module-level registry pattern to allow the UI layer
 * to register its implementation without creating import dependencies.
 */
let registeredService: IRunStorageService = new NullRunStorageService();

/**
 * Register a run storage service implementation.
 * Called by ProgressViewProvider during initialization.
 */
export function registerRunStorageService(service: IRunStorageService): void {
  registeredService = service;
}

/**
 * Get the current run storage service.
 * Returns NullRunStorageService if no implementation has been registered.
 */
export function getRunStorageService(): IRunStorageService {
  return registeredService;
}

/**
 * Clear the registered service (useful for testing).
 */
export function clearRunStorageService(): void {
  registeredService = new NullRunStorageService();
}
