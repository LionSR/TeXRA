// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

export async function loadDesktopPlatformModule<T>(
  moduleName: string,
): Promise<T> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'platform', moduleName))
  ) as Promise<T>;
}
