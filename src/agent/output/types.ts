import type { DiffStats } from '@/types/DiffTypes';
import type { OutputFileId, WithEntityId } from '../../types/EntityTypes';

export interface NamedOutputFile extends WithEntityId<OutputFileId> {
  source: string;
  path: string;
}

export interface OutputFileInfo extends WithEntityId<OutputFileId>, DiffStats {
  path: string;
  base?: string | null;
  prev?: string | null;
  original?: string | null;
}
