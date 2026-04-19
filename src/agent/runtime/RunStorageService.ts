/**
 * Decouples agent runtime from ProgressView UI layer.
 */

/** Interface for run state access - implemented by ProgressViewProvider */
export interface IRunStorageService {
  isViewVisible(): boolean;
}

let service: IRunStorageService | null = null;

/** Default no-op service when ProgressView is not registered */
const DEFAULT_SERVICE: IRunStorageService = {
  isViewVisible: () => false,
};

export function setRunStorageService(s: IRunStorageService): void {
  service = s;
}

/** Returns service or safe defaults if not registered */
export function getRunStorageService(): IRunStorageService {
  return service ?? DEFAULT_SERVICE;
}
