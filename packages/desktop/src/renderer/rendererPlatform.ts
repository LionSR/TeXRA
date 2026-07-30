/** Returns the Electron renderer platform from browser navigator data. */
export function getRendererPlatform(view: Window | null): NodeJS.Platform {
  const platform = view?.navigator.platform.toLowerCase() ?? '';
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('win')) return 'win32';
  if (platform.includes('linux')) return 'linux';
  // Fall back to the host platform when the browser navigator is inconclusive.
  return typeof process === 'undefined' ? 'linux' : process.platform;
}
