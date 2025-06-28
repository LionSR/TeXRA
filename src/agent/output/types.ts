export interface NamedOutputFile {
  source: string;
  path: string;
}

import type { DiffStats } from '@/types/DiffTypes';

export interface OutputFileInfo extends DiffStats {
  path: string;
  base?: string | null;
  prev?: string | null;
  original?: string | null;
}
