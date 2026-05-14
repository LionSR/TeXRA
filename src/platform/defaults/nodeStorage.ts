// Node imports
import * as os from 'os';
import * as path from 'path';

// Local imports - platform
import { createWorkspaceStorageProvider } from './workspaceStorage';
import type { StorageProvider } from '../interfaces/storage';

export const DEFAULT_NODE_STORAGE_ROOT = path.join(os.homedir(), '.texra');

interface NodeStorageProviderOptions {
  readonly storageRoot?: string;
  readonly workspacePath?: string | (() => string | undefined);
}

export function createNodeStorageProvider({
  storageRoot = DEFAULT_NODE_STORAGE_ROOT,
  workspacePath,
}: NodeStorageProviderOptions = {}): StorageProvider {
  return createWorkspaceStorageProvider(storageRoot, workspacePath);
}
