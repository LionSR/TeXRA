// Local imports - agent
import type { StorageKey } from '@agent/types/IdentifierTypes';
import type { AgentLogStage } from '@logger/AgentLogger';
import type { FileLocation } from '@utils/files';

// Local file imports
import type { LatexDiffManager } from './LatexDiffManager';
import type {
  OutputFileInfo,
  OutputXmlSummary,
  RoundFileMapping,
  RoundOutput,
} from './types';

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

  /** Ensure storage for a round and return its outputs. */
  ensureRound(round: number): OutputFileInfo[];

  /** Determine whether a round has generated outputs. */
  hasRoundOutputs(round: number): boolean;

  /** Process output files from XML or direct input. */
  processOutputFiles(
    outputLocation: FileLocation,
    currRound: number,
    stage?: AgentLogStage,
  ): Promise<void>;

  /** Gather mapping and diff stats for output files of a round. */
  gatherOutputFileInfo(currRound: number): Promise<OutputFileInfo[]>;

  /** Retrieve the cached mapping metadata for a round. */
  getRoundMapping(currRound: number): RoundFileMapping;

  /** Validate expected output files for the given round. */
  validateExpectedOutputs(
    outputLocation: FileLocation,
    currRound: number,
    stage?: AgentLogStage,
  ): Promise<void>;

  /** Finalize processing for a round. */
  finalizeRound(
    outputFile: FileLocation,
    currRound: number,
    options: {
      endTurn: boolean;
      stage?: AgentLogStage;
    },
  ): Promise<void>;

  getRoundArtifacts(round: number): Promise<RoundOutput>;
  getRoundXmlSummary(round: number): OutputXmlSummary;

  /**
   * Set the active storage key for this handler.
   * @param storageKey - THE key for storage operations (task group ID or execution ID)
   */
  setActiveRun(storageKey: StorageKey): void;

}
