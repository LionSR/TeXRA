import type { AgentLogStage } from '@logger/AgentLogger';
import type {
  FileLocation,
  OutputFileInfo,
  RoundOutput,
  StorageKey,
} from '@shared/schemas';

import type { LatexDiffManager } from './LatexDiffManager';
import type { RoundFileMapping } from './types';

/** Interface describing OutputHandler behavior used by agents. */
export interface IOutputHandler {
  /** Map of generated output files by round. */
  outputFiles: { [key: number]: OutputFileInfo[] };

  /** Manager responsible for orchestrating latexdiff operations. */
  readonly diffManager: LatexDiffManager;

  /**
   * Ensure the XML output file has correct structure (closing tags, etc.).
   */
  ensureXmlStructure(
    fileLocation: FileLocation,
    documentTag: string,
  ): Promise<void>;

  /** Determine whether a round has generated outputs. */
  hasRoundOutputs(round: number): boolean;

  /** Process output files from XML or direct input. */
  processOutputFiles(
    outputLocation: FileLocation,
    currRound: number,
    stage?: AgentLogStage,
  ): Promise<void>;

  /** Retrieve the cached mapping metadata for a round. */
  getRoundMapping(currRound: number): RoundFileMapping;

  /** Finalize processing for a round. */
  finalizeRound(
    outputFile: FileLocation,
    currRound: number,
    options: {
      endTurn: boolean;
      stage?: AgentLogStage;
      mapping?: RoundFileMapping;
    },
  ): Promise<void>;

  getRoundArtifacts(round: number): Promise<RoundOutput>;

  /**
   * Set the active storage key for this handler.
   * @param storageKey - THE key for storage operations (task group ID or execution ID)
   */
  setActiveRun(storageKey: StorageKey): void;
}
