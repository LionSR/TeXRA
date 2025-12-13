/**
 * Decouples agent runtime from ProgressView UI layer.
 */
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamTabId, StorageKey } from '@shared/identifiers';

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

export const setRunStorageService = (s: IRunStorageService): void => {
  service = s;
};

/** Returns service or safe defaults if not registered */
export const getRunStorageService = (): IRunStorageService =>
  service ?? {
    getActiveRunId: () => null,
    getRunOutputFiles: () => undefined,
    isViewVisible: () => false,
  };

/** Reset to default state (for testing) */
export const resetRunStorageService = (): void => {
  service = null;
};
