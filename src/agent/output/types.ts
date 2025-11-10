// Local imports - agent
import type { DiffStats } from '@agent/types/DiffTypes';

// Local imports - files
import type { FileLocation } from '@utils/files/taskRunStorage';

export interface OutputXmlSummary {
  tagContents: Record<string, string | string[]>;
  documents: string[];
  singleOutputFile: string | null;
  sourceLocation?: FileLocation | null;
}

export interface NamedOutputFile {
  source: string;
  path: string;
  relativePath: string;
  workspacePath?: string;
  location: FileLocation;
}

export interface OutputFileInfo extends DiffStats {
  path: string;
  relativePath: string;
  displayLabel: string;
  displayDir: string;
  workspacePath?: string | null;
  base?: string | null;
  prev?: string | null;
  original?: string | null;
  location: FileLocation;
  baseLocation?: FileLocation | null;
  prevLocation?: FileLocation | null;
  originalLocation?: FileLocation | null;
  source?: string | null;
  rawOutputPath?: string | null;
  rawLocation?: FileLocation | null;
  xmlSummary?: OutputXmlSummary | null;
}

export interface RoundFileMapping {
  baseToOutput: Map<string, string>;
  prevToOutput: Map<string, string>;
  originByOutput: Map<string, string | undefined>;
  locationByOutput: Map<string, FileLocation>;
}

export interface RoundOutputArtifacts {
  round: number;
  rawOutput: FileLocation | null;
  rawOutputPath: string | null;
  outputFiles: string[];
  processedFiles: NamedOutputFile[];
  fileInfos: OutputFileInfo[];
  xmlSummary: OutputXmlSummary;
}
