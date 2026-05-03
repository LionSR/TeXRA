// Node imports
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadDesktopPlatformModule<T>(
  moduleName: string,
): Promise<T> {
  const modulePath = resolve(
    process.cwd(),
    'packages/desktop/src/main/platform',
    moduleName,
  );
  return import(pathToFileURL(modulePath).href) as Promise<T>;
}
