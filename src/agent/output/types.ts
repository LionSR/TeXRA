// Local imports - agent
import type { DiffStats } from '@agent/types/DiffTypes';

export interface NamedOutputFile {
  source: string;
  path: string;
}

export interface OutputFileInfo extends DiffStats {
  path: string;
  base?: string | null;
  prev?: string | null;
  original?: string | null;
}

export interface RoundOutputMapping {
  baseToOutput: Map<string, string>;
  prevToCurrent: Map<string, string>;
  outputToOrigin: Map<string, string>;
}
