/**
 * Platform Abstraction Layer — service interfaces.
 *
 * Every interface defines what the host environment (VS Code, CLI, Electron,
 * Web) must provide. Core business logic codes against these interfaces,
 * never against a specific host API.
 *
 * Existing interfaces (FileSystemProvider, ConfigProvider, etc.) are
 * re-exported from their original modules for backward compatibility.
 */

// Re-export existing interfaces as canonical platform types
export type { ConfigProvider as PlatformConfig } from '@agent/core/config';
export type { StateStore as PlatformState } from '@agent/core/stateStore';
export type { LogBackend as PlatformLog } from '@agent/core/logger';
export type {
  FileSystemProvider as PlatformFS,
  FileStat,
  FileType,
} from '@agent/core/filesystem';
export type { WorkspaceProvider as PlatformWorkspace } from '@agent/core/workspace';
export type { StorageProvider as PlatformStorage } from '@agent/core/storage';

// New: Secrets — the 8th platform service
export { type PlatformSecrets } from './secrets';
