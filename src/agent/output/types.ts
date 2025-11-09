// Local imports - agent
import type { DiffStats } from '@agent/types/DiffTypes';

export interface NamedOutputFile {
  source: string;
  path: string;
  workspacePath?: string;
  runStoragePath?: string | null;
  relativePath?: string | null;
  displayName?: string | null;
}

export interface OutputFileInfo extends DiffStats {
  path: string;
  workspacePath?: string | null;
  runStoragePath?: string | null;
  relativePath?: string | null;
  displayName?: string | null;
  displayPath?: string | null;
  base?: string | null;
  prev?: string | null;
  original?: string | null;
}

export interface RoundFileMapping {
  baseToOutput: Map<string, string>;
  prevToOutput: Map<string, string>;
  originByOutput: Map<string, string | undefined>;
  workspaceByOutput: Map<string, string>;
}
