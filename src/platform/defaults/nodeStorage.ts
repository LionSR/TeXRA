// Node imports
import * as os from 'node:os';
import * as path from 'node:path';

// Local imports - platform
import { WorkspaceStorageProvider } from './workspaceStorage';
import type { StorageProvider } from '../interfaces';

/** Directory name for TeXRA data, both global (`~/.texra`) and per-project (`<workspace>/.texra`). */
export const TEXRA_STORAGE_DIR_NAME = '.texra';

/** File name of the JSON config file inside a `.texra` directory. */
export const TEXRA_CONFIG_FILE_NAME = 'config.json';

export const DEFAULT_NODE_STORAGE_ROOT = path.join(
  os.homedir(),
  TEXRA_STORAGE_DIR_NAME,
);

/**
 * Project-local config file shared by the CLI, extension, and desktop app:
 * `<workspaceRoot>/.texra/config.json`.
 */
export function workspaceTexraConfigPath(workspaceRoot: string): string {
  return path.join(
    workspaceRoot,
    TEXRA_STORAGE_DIR_NAME,
    TEXRA_CONFIG_FILE_NAME,
  );
}

interface NodeStorageProviderOptions {
  readonly storageRoot?: string;
  readonly workspacePath?: string | (() => string | undefined);
}

export function createNodeStorageProvider({
  storageRoot = DEFAULT_NODE_STORAGE_ROOT,
  workspacePath,
}: NodeStorageProviderOptions = {}): StorageProvider {
  return new WorkspaceStorageProvider(storageRoot, workspacePath);
}
