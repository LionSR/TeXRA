// Node imports
import * as os from 'node:os';
import * as path from 'node:path';

/** Directory name for TeXRA data, both global (`~/.texra`) and per-project (`<workspace>/.texra`). */
export const TEXRA_STORAGE_DIR_NAME = '.texra';

/** File name of the JSON config file inside a `.texra` directory. */
export const TEXRA_CONFIG_FILE_NAME = 'config.json';

/** The global TeXRA data root, `~/.texra`, read from the home directory at
 *  each call so nothing caches a home resolved before the environment set. */
export function defaultNodeStorageRoot(): string {
  const home = os.homedir();
  return path.join(home, TEXRA_STORAGE_DIR_NAME);
}

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
