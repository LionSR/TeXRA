/**
 * Decouples agent runtime from ProgressView UI layer.
 */
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamTabId, StorageKey } from '@agent/types/IdentifierTypes';

/** Interface for run state access - implemented by ProgressViewProvider */
export interface IRunStorageService {
  getActiveRunId(stream: StreamTabId): StorageKey | null;
  getRunOutputFiles(
    stream: StreamTabId,
    options: { storageKey: StorageKey },
  ): Map<number, OutputFileInfo[]> | undefined;
  isViewVisible(): boolean;
}

let service: IRunStorageService | null = null;

/** Default no-op service when ProgressView is not registered */
const DEFAULT_SERVICE: IRunStorageService = {
  getActiveRunId: () => null,
  getRunOutputFiles: () => undefined,
  isViewVisible: () => false,
};

export function setRunStorageService(s: IRunStorageService): void {
  service = s;
}

/** Returns service or safe defaults if not registered */
export function getRunStorageService(): IRunStorageService {
  return service ?? DEFAULT_SERVICE;
}

/** Reset to default state (for testing) */
export function resetRunStorageService(): void {
  service = null;
}
