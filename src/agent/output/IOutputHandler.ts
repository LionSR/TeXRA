// Local imports - agent
import type { AgentLogStage } from '@logger/AgentLogger';

// Local file imports
import { LatexDiffManager } from './LatexDiffManager';
import { XmlOutputManager } from './XmlOutputManager';
import {
  OutputFileInfo,
  OutputXmlSummary,
  RoundFileMapping,
  RoundOutput,
} from './types';

/** Interface describing OutputHandler behavior used by agents. */
export interface IOutputHandler {
  /** Map of generated output files by round. */
  outputFiles: { [key: number]: OutputFileInfo[] };

  /** Mapping of source to processed output files by round. */
  outputMappings: { [key: number]: OutputFileInfo[] };

  /** XML manager for parsing and splitting outputs. */
  xmlManager: XmlOutputManager;

  /** Manager responsible for orchestrating latexdiff operations. */
  readonly diffManager: LatexDiffManager;

  /** Ensure storage for a round and return its outputs. */
  ensureRound(round: number): OutputFileInfo[];

  /** Determine whether a round has generated outputs. */
  hasRoundOutputs(round: number): boolean;

  /** Indent a single LaTeX file for readability. */
  indentLatexFile(filePath: string): Promise<void>;

  /** Indent multiple LaTeX files for readability. */
  indentLatexFiles(filePaths: string[]): Promise<void>;

  /** Process output files from XML or direct input. */
  processOutputFiles(
    outputFile: string,
    currRound: number,
    stage?: AgentLogStage,
  ): Promise<void>;

  /** Gather mapping and diff stats for output files of a round. */
  gatherOutputFileInfo(currRound: number): Promise<OutputFileInfo[]>;

  /** Retrieve the cached mapping metadata for a round. */
  getRoundMapping(currRound: number): RoundFileMapping;

  /** Validate expected output files for the given round. */
  validateExpectedOutputs(
    outputFile: string,
    currRound: number,
    stage?: AgentLogStage,
  ): Promise<void>;

  /** Finalize processing for a round. */
  finalizeRound(
    outputFile: string,
    currRound: number,
    options: {
      endTurn: boolean;
      stage?: AgentLogStage;
    },
  ): Promise<void>;

  hydrateFromArtifacts(
    runId: string | null | undefined,
    rounds: Map<number, OutputFileInfo[]>,
  ): void;

  getRoundArtifacts(round: number): Promise<RoundOutput>;
  getRoundXmlSummary(round: number): OutputXmlSummary;
  setActiveRun(runId?: string | null): void;
}
