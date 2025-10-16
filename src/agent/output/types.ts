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

export interface RoundFileMapping {
  baseToOutput: Map<string, string>;
  prevToOutput: Map<string, string>;
  originByOutput: Map<string, string | undefined>;
}
