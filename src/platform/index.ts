/**
 * Platform Abstraction Layer.
 *
 * Import structure (no re-exports — import from the source):
 *
 *   Composition root:  import { initPlatform, platform } from '@platform/platform'
 *   Interfaces:        import type { ConfigProvider } from '@platform/interfaces/config'
 *   Defaults:          import { nodeFilesystem } from '@platform/defaults/nodeFilesystem'
 *   Secrets:           import type { PlatformSecrets } from '@platform/secrets'
 */

// Only export the composition root — everything else is imported directly.
export { initPlatform, platform, tryPlatform, type Platform } from './platform';
