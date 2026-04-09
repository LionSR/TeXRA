/**
 * Platform Abstraction Layer — public API.
 *
 * Hosts call `initPlatform()` at startup. Core code calls `platform()`
 * to access services, or uses the convenience facades in `@agent/core/`.
 */
export { initPlatform, platform, type Platform } from './platform';
export type {
  PlatformConfig,
  PlatformState,
  PlatformLog,
  PlatformFS,
  PlatformWorkspace,
  PlatformStorage,
  PlatformSecrets,
} from './interfaces';
export type { FileStat, FileType } from './interfaces';
