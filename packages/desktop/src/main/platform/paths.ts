import { join } from 'node:path';

/** Where this build's files are. */
export type DesktopLayout = ReturnType<typeof desktopLayout>;

/**
 * Where this build's files are, from the directory of the entry module
 * (`dist/main/index.js`, `main` in package.json), which sits beside the
 * built preload script and renderer page. The bundled extension tree is the
 * packaged app's `Resources/` (`extraResources` in `electron-builder.yml`),
 * or in a development run the extension package beside this one.
 */
export function desktopLayout(mainDir: string, isPackaged: boolean) {
  const extension = isPackaged
    ? process.resourcesPath
    : join(mainDir, '../../../extension');
  return {
    preload: join(mainDir, '../preload/index.cjs'),
    rendererPage: join(mainDir, '../renderer/index.html'),
    /** The `packages/extension/resources` tree. */
    resourcesPath: join(extension, 'resources'),
    /** The directory the background service's bundle (`serve/`) is in. */
    serviceRoot: extension,
  };
}
