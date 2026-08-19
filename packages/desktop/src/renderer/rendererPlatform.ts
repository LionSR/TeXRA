import type { DesktopPlatform } from '@shared/commands/accelerators';

/**
 * Returns the Electron renderer platform from browser navigator data. The
 * renderer has no Node types by design, so an inconclusive navigator falls
 * back to the non-mac branch rather than reading `process.platform`.
 */
export function getRendererPlatform(view: Window | null): DesktopPlatform {
  const platform = view?.navigator.platform.toLowerCase() ?? '';
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('win')) return 'win32';
  return 'linux';
}
