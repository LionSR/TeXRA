// Local imports - agent
// Local imports - types
import { NamedOutputFile, OutputFileInfo } from './types';
import { XmlOutputManager } from './XmlOutputManager';

/** Interface describing OutputHandler behavior used by agents. */
export interface IOutputHandler {
  /** Map of generated output files by round. */
  outputFiles: { [key: number]: string[] };

  /** Mapping of source to processed output files by round. */
  outputMappings: { [key: number]: NamedOutputFile[] };

  /** XML manager for parsing and splitting outputs. */
  xmlManager: XmlOutputManager;

  /** Ensure storage for a round and return its outputs. */
  ensureRound(round: number): string[];

  /** Retrieve the outputs for a round, creating storage if needed. */
  getRoundOutputs(round: number): string[];

  /** Determine whether a round has generated outputs. */
  hasRoundOutputs(round: number): boolean;

  /** Indent a single LaTeX file for readability. */
  indentLatexFile(filePath: string): Promise<void>;

  /** Indent multiple LaTeX files for readability. */
  indentLatexFiles(filePaths: string[]): Promise<void>;

  /** Run latexdiff comparisons for the current round. */
  handleLatexdiffofOutput(currRound: number, groupId?: string): Promise<void>;

  /** Process output files from XML or direct input. */
  processOutputFiles(
    outputFile: string,
    currRound: number,
    groupId?: string,
  ): Promise<void>;

  /** Gather mapping and diff stats for output files of a round. */
  gatherOutputFileInfo(currRound: number): Promise<OutputFileInfo[]>;

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
}
