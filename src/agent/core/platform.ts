/**
 * Composition root for agent-core platform services.
 *
 * Re-exports from `@platform/` for backward compatibility.
 * New code should import from `@platform/` directly.
 */
export { initPlatform, platform, type Platform } from '@platform/platform';

// Re-export individual types for existing consumers
export type { ConfigProvider } from './config';
export type { StateStore } from './stateStore';
export type { LogBackend } from './logger';
export type { FileSystemProvider } from './filesystem';
export type { WorkspaceProvider } from './workspace';
export type { StorageProvider } from './storage';

/**
 * @deprecated Use `Platform` from `@platform/platform` instead.
 * Kept for backward compatibility with existing `initPlatform()` callers.
 */
export type PlatformServices = import('@platform/platform').Platform;
