// Local imports - agent
import { LatexDiffManager } from './LatexDiffManager';
import { XmlOutputManager } from './XmlOutputManager';

// Local imports - types
import {
  NamedOutputFile,
  OutputFileInfo,
  RoundFileMapping,
} from './types';
import type { OutputXmlSummary, RoundOutputArtifacts } from './OutputHandler';

/** Interface describing OutputHandler behavior used by agents. */
export interface IOutputHandler {
  /** Map of generated output files by round. */
  outputFiles: { [key: number]: string[] };

  /** Mapping of source to processed output files by round. */
  outputMappings: { [key: number]: NamedOutputFile[] };

  /** XML manager for parsing and splitting outputs. */
  xmlManager: XmlOutputManager;

  /** Manager responsible for orchestrating latexdiff operations. */
  readonly diffManager: LatexDiffManager;

  /** Ensure storage for a round and return its outputs. */
  ensureRound(round: number): string[];

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
    groupId?: string,
  ): Promise<void>;

  /** Gather mapping and diff stats for output files of a round. */
  gatherOutputFileInfo(currRound: number): Promise<OutputFileInfo[]>;

  /** Retrieve the cached mapping metadata for a round. */
  getRoundMapping(currRound: number): RoundFileMapping;

  /** Validate expected output files for the given round. */
  validateExpectedOutputs(
    outputFile: string,
    currRound: number,
    groupId?: string,
  ): Promise<void>;

  /** Finalize processing for a round. */
  finalizeRound(
    outputFile: string,
    currRound: number,
    options: {
      endTurn: boolean;
      groupId?: string;
    },
  ): Promise<void>;

  getRoundArtifacts(round: number): Promise<RoundOutputArtifacts>;
  getRoundXmlSummary(round: number): OutputXmlSummary;
}
