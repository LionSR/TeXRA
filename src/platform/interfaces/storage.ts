/**
 * Platform storage path provider interface.
 */
export interface StorageProvider {
  /** Per-workspace storage root path. */
  getStoragePath(): string;

  /** Cross-workspace global storage root path. */
  getGlobalStoragePath(): string;
}
